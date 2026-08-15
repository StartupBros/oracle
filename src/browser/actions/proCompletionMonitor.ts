import type { BrowserLogger, ChromeClient } from "../types.js";
import {
  evaluateProTurnCompletion,
  type ConversationMapping,
  type ProTurnCompletion,
} from "./proTurnCompletion.js";

const SUBMISSION_PATH = "/backend-api/f/conversation";
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const MIN_POLL_INTERVAL_MS = 1_000;
const MAX_POLL_INTERVAL_MS = 10_000;
const DEFAULT_MAPPING_REQUEST_TIMEOUT_MS = 10_000;
/** Additional consecutive polls that must repeat the same final message before it is trusted. */
const STRUCTURAL_CONFIRM_POLLS = 1;
const MAX_CANDIDATE_REQUESTS = 8;
const MAX_CANDIDATE_AGE_MS = 30_000;

type NetworkRequestEvent = {
  requestId: string;
  request?: { url?: string; method?: string };
};

type NetworkResponseEvent = {
  requestId: string;
  response?: { status?: number; mimeType?: string };
};

type NetworkLoadingFinishedEvent = { requestId: string };

type StreamHandoff = {
  conversationId: string;
  turnExchangeId: string;
};

export interface ProStructuralAnswer {
  text: string;
  messageId: string;
  modelSlug?: string;
  finishReason?: string;
}

export type ProCompletionObservation =
  | { status: "verified"; answer: ProStructuralAnswer }
  | { status: "unavailable"; reason: string }
  | { status: "inconclusive"; reason: string };

export interface ProCompletionMonitor {
  reset(): void;
  arm(): void;
  waitForCompletion(timeoutMs: number): Promise<ProCompletionObservation>;
  stop(): void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

interface CandidateRequest {
  generation: number;
  responseStatus?: number;
  bodyRead: boolean;
  createdAt: number;
}

type MappingResponse = {
  status: number;
  body?: { mapping?: ConversationMapping };
  timedOut?: boolean;
  unauthorized?: boolean;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/**
 * Observe the page's own conversation submission and verify Pro completion from
 * the authenticated browser session. This never intercepts or rewrites a request:
 * Network events are passive, and the mapping GET stays inside the page so cookies
 * remain in Chrome rather than crossing into the Node process.
 */
export function createProCompletionMonitor(
  Network: ChromeClient["Network"],
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
): ProCompletionMonitor {
  let generation = 0;
  let stopped = false;
  let armed = false;
  let handoff: StreamHandoff | null = null;
  let handoffSignal = deferred<StreamHandoff | null>();
  const candidates = new Map<string, CandidateRequest>();

  const reset = (): void => {
    if (stopped) return;
    generation += 1;
    armed = false;
    handoff = null;
    candidates.clear();
    handoffSignal.resolve(null);
    handoffSignal = deferred<StreamHandoff | null>();
  };

  const arm = (): void => {
    if (stopped) return;
    generation += 1;
    armed = true;
    handoff = null;
    candidates.clear();
    handoffSignal.resolve(null);
    handoffSignal = deferred<StreamHandoff | null>();
  };

  const onRequest = (event: NetworkRequestEvent): void => {
    if (stopped || !armed || handoff || candidates.has(event.requestId)) return;
    if (!isConversationSubmissionUrl(event.request?.url)) return;
    const now = Date.now();
    for (const [candidateId, candidate] of candidates) {
      if (now - candidate.createdAt >= MAX_CANDIDATE_AGE_MS) {
        candidates.delete(candidateId);
      }
    }
    if (event.request?.method && event.request.method.toUpperCase() !== "POST") return;

    while (candidates.size >= MAX_CANDIDATE_REQUESTS) {
      const oldest = candidates.keys().next().value as string | undefined;
      if (!oldest) break;
      candidates.delete(oldest);
    }
    candidates.set(event.requestId, {
      generation,
      bodyRead: false,
      createdAt: Date.now(),
    });
    if (logger.verbose) {
      logger(`[browser] structural monitor tracking conversation request ${event.requestId}`);
    }
  };

  const onResponse = (event: NetworkResponseEvent): void => {
    const candidate = candidates.get(event.requestId);
    if (stopped || !candidate || candidate.generation !== generation) return;
    candidate.responseStatus = event.response?.status;
    if (logger.verbose) {
      logger(
        `[browser] structural monitor received conversation response ${String(candidate.responseStatus ?? "unknown")}`,
      );
    }
  };

  const onLoadingFinished = async (event: NetworkLoadingFinishedEvent): Promise<void> => {
    const candidate = candidates.get(event.requestId);
    if (
      stopped ||
      !armed ||
      handoff ||
      !candidate ||
      candidate.generation !== generation ||
      candidate.bodyRead
    ) {
      return;
    }
    candidate.bodyRead = true;
    const eventGeneration = generation;
    try {
      if (
        candidate.responseStatus !== undefined &&
        (candidate.responseStatus < 200 || candidate.responseStatus >= 300)
      ) {
        candidates.delete(event.requestId);
        return;
      }
      const body = await Network.getResponseBody({ requestId: event.requestId });
      if (
        stopped ||
        !armed ||
        eventGeneration !== generation ||
        candidates.get(event.requestId) !== candidate
      ) {
        return;
      }
      const text = body.base64Encoded
        ? Buffer.from(body.body, "base64").toString("utf8")
        : body.body;
      const nextHandoff = extractStreamHandoff(text);
      candidates.delete(event.requestId);
      if (nextHandoff) {
        handoff = nextHandoff;
        handoffSignal.resolve(nextHandoff);
      } else if (logger.verbose) {
        logger(
          "[browser] structural monitor ignored conversation response without Pro stream handoff",
        );
      }
    } catch {
      candidates.delete(event.requestId);
      if (logger.verbose) {
        logger("[browser] structural monitor could not read conversation response");
      }
    }
  };

  const unsubscribe = [
    Network.requestWillBeSent(onRequest) as unknown as () => void,
    Network.responseReceived(onResponse) as unknown as () => void,
    Network.loadingFinished(onLoadingFinished) as unknown as () => void,
  ];

  const waitForCompletion = async (timeoutMs: number): Promise<ProCompletionObservation> => {
    const eventGeneration = generation;
    const deadline = Date.now() + Math.max(timeoutMs, 0);
    const bootstrap = await waitWithTimeout(
      handoffSignal.promise,
      Math.min(DEFAULT_BOOTSTRAP_TIMEOUT_MS, Math.max(0, deadline - Date.now())),
    );
    if (stopped || eventGeneration !== generation) {
      return { status: "unavailable", reason: "monitor stopped or reset" };
    }
    if (!bootstrap) {
      armed = false;
      return { status: "unavailable", reason: "Pro stream handoff not observed" };
    }

    let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
    let lastReason = "mapping not fetched";
    // A single positive snapshot is NOT proof. Pro can emit a terminal-shaped interim
    // text and only afterwards resume reasoning, so a mapping fetched inside that window
    // looks complete while the turn is still running. Require the same final message to
    // survive consecutive polls before trusting it, mirroring the DOM gate's own
    // confirm-cycle pattern. Any non-terminal observation discards the candidate.
    let pendingAnswer: ProStructuralAnswer | null = null;
    let pendingConfirmations = 0;
    while (!stopped && eventGeneration === generation && Date.now() < deadline) {
      const remainingMs = Math.max(0, deadline - Date.now());
      if (remainingMs <= 0) break;
      let mappingResponse: MappingResponse | null = null;
      try {
        mappingResponse = await fetchConversationMapping(
          Runtime,
          bootstrap.conversationId,
          Math.min(DEFAULT_MAPPING_REQUEST_TIMEOUT_MS, remainingMs),
        );
      } catch {
        // A transient page-context/CDP failure must not abort the browser turn.
        // The existing DOM completion path remains the fallback authority.
        lastReason = "mapping request failed";
      }
      if (stopped || eventGeneration !== generation) {
        return { status: "unavailable", reason: "monitor stopped or reset" };
      }
      if (mappingResponse?.timedOut) {
        lastReason = "mapping request timed out";
      } else if (mappingResponse?.status === 200) {
        const mapping = mappingResponse.body?.mapping;
        if (!mapping || typeof mapping !== "object") {
          lastReason = "mapping response missing mapping";
        } else {
          pollIntervalMs = readPollInterval(mapping, bootstrap.turnExchangeId, pollIntervalMs);
          const verification = evaluateProTurnCompletion(mapping, bootstrap.turnExchangeId);
          lastReason = verification.reason ?? "verified";
          const answer = toStructuralAnswer(verification);
          if (answer) {
            if (pendingAnswer && pendingAnswer.messageId === answer.messageId) {
              pendingConfirmations += 1;
            } else {
              pendingAnswer = answer;
              pendingConfirmations = 0;
            }
            if (pendingConfirmations >= STRUCTURAL_CONFIRM_POLLS) {
              armed = false;
              return { status: "verified", answer };
            }
            lastReason = "completion awaiting stability confirmation";
          } else {
            // Reasoning resumed (or the branch changed): the previous candidate was interim.
            pendingAnswer = null;
            pendingConfirmations = 0;
          }
        }
      } else if (mappingResponse?.unauthorized) {
        // Not recoverable by polling: stop early and let the DOM path own this turn.
        lastReason = `mapping request unauthorized (HTTP ${mappingResponse.status})`;
        break;
      } else if (mappingResponse) {
        lastReason = `mapping request returned HTTP ${mappingResponse.status}`;
      }
      await delayUntilNextPoll(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    }

    armed = false;
    if (lastReason !== "verified" && logger.verbose) {
      logger(`[browser] structural completion inconclusive: ${lastReason}`);
    }
    return { status: "inconclusive", reason: lastReason };
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    armed = false;
    generation += 1;
    candidates.clear();
    handoffSignal.resolve(null);
    for (const remove of unsubscribe) {
      try {
        remove();
      } catch {
        // Best effort; CDP cleanup must not mask the browser result.
      }
    }
  };

  return { reset, arm, waitForCompletion, stop };
}

function toStructuralAnswer(result: ProTurnCompletion): ProStructuralAnswer | null {
  if (!result.done || !result.finalText || !result.finalMessageId) return null;
  return {
    text: result.finalText,
    messageId: result.finalMessageId,
    modelSlug: result.modelSlug,
    finishReason: result.finishReason,
  };
}

function isConversationSubmissionUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).pathname.endsWith(SUBMISSION_PATH);
  } catch {
    return url.split("?", 1)[0]?.endsWith(SUBMISSION_PATH) ?? false;
  }
}

export function extractStreamHandoff(sseText: string): StreamHandoff | null {
  for (const event of sseText.split(/\n\s*\n/)) {
    const dataLine = event.split("\n").find((line) => line.trimStart().startsWith("data:"));
    if (!dataLine) continue;
    const json = dataLine.slice(dataLine.indexOf("data:") + 5).trim();
    if (!json || json === "[DONE]") continue;
    try {
      const parsed = JSON.parse(json) as Record<string, unknown>;
      if (parsed.type !== "stream_handoff") continue;
      const conversationId = parsed.conversation_id;
      const turnExchangeId = parsed.turn_exchange_id;
      if (typeof conversationId !== "string" || !conversationId) continue;
      if (typeof turnExchangeId !== "string" || !turnExchangeId) continue;
      return { conversationId, turnExchangeId };
    } catch {
      // Ignore non-JSON SSE events.
    }
  }
  return null;
}

async function fetchConversationMapping(
  Runtime: ChromeClient["Runtime"],
  conversationId: string,
  timeoutMs: number,
): Promise<MappingResponse | null> {
  const boundedTimeoutMs = Math.max(1, Math.floor(timeoutMs));
  // The bearer token is read, cached, and used ENTIRELY inside the page: only the HTTP
  // status and the conversation mapping cross back into Node. Cookies alone do not
  // authenticate `/backend-api/conversation/<id>` — it answers 404
  // `conversation_inaccessible` ("Log in to view this conversation"), so a cookie-only
  // poll can never verify a real signed-in run.
  const expression = `(async () => {
    const TOKEN_KEY = '__oracleStructuralCompletionToken';
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => controller?.abort(), ${boundedTimeoutMs});
    const isAuthFailure = (res) => {
      if (!res) return false;
      if (res.status === 401 || res.status === 403) return true;
      const code = res.body && res.body.detail && res.body.detail.code;
      return res.status === 404 && code === 'conversation_inaccessible';
    };
    const readToken = async (force) => {
      if (!force && typeof globalThis[TOKEN_KEY] === 'string' && globalThis[TOKEN_KEY]) {
        return globalThis[TOKEN_KEY];
      }
      try {
        const session = await fetch('/api/auth/session', {
          credentials: 'include',
          signal: controller?.signal,
        });
        const parsed = await session.json().catch(() => null);
        const token = parsed && typeof parsed.accessToken === 'string' ? parsed.accessToken : '';
        globalThis[TOKEN_KEY] = token;
        return token;
      } catch (_error) {
        return '';
      }
    };
    const request = async (token) => {
      const headers = { Accept: 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      const response = await fetch('/backend-api/conversation/' + encodeURIComponent(${JSON.stringify(conversationId)}), {
        credentials: 'include',
        headers,
        signal: controller?.signal,
      });
      const text = await response.text();
      let body;
      try { body = text ? JSON.parse(text) : undefined; } catch (_error) { body = undefined; }
      return { status: response.status, body };
    };
    try {
      let result = await request(await readToken(false));
      if (isAuthFailure(result)) {
        const refreshed = await readToken(true);
        if (refreshed) result = await request(refreshed);
      }
      const mapping = result.body && result.body.mapping ? result.body.mapping : undefined;
      return {
        status: result.status,
        body: mapping ? { mapping } : undefined,
        unauthorized: isAuthFailure(result),
      };
    } catch (error) {
      return { status: 0, timedOut: error?.name === 'AbortError' };
    } finally {
      clearTimeout(timer);
    }
  })()`;
  const result = await withTimeout(
    Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true }),
    boundedTimeoutMs,
  );
  if (!result) return { status: 0, timedOut: true };
  const value = result.result?.value as
    | {
        status?: unknown;
        body?: { mapping?: ConversationMapping };
        timedOut?: unknown;
        unauthorized?: unknown;
      }
    | null
    | undefined;
  if (!value || typeof value.status !== "number") return null;
  return {
    status: value.status,
    body: value.body,
    timedOut: value.timedOut === true,
    unauthorized: value.unauthorized === true,
  };
}

function readPollInterval(
  mapping: ConversationMapping,
  turnExchangeId: string,
  fallback: number,
): number {
  for (const node of Object.values(mapping)) {
    const message = node.message;
    if (message?.metadata?.turn_exchange_id !== turnExchangeId) continue;
    const value = message.metadata?.poll_interval_ms;
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, value));
    }
  }
  return fallback;
}

async function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  if (timeoutMs <= 0) return null;
  return await withTimeout(promise, timeoutMs);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  if (timeoutMs <= 0) return null;
  return await new Promise<T | null>((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function delayUntilNextPoll(timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
}
