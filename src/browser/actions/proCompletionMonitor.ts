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

export interface ProCompletionMonitor {
  reset(): void;
  waitForCompletion(timeoutMs: number): Promise<ProStructuralAnswer | null>;
  stop(): void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

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
  let requestId: string | undefined;
  let responseStatus: number | undefined;
  let handoff: StreamHandoff | null = null;
  let handoffSignal = deferred<StreamHandoff | null>();

  const reset = (): void => {
    generation += 1;
    requestId = undefined;
    responseStatus = undefined;
    handoff = null;
    handoffSignal.resolve(null);
    handoffSignal = deferred<StreamHandoff | null>();
  };

  const onRequest = (event: NetworkRequestEvent): void => {
    if (stopped || requestId || !isConversationSubmissionUrl(event.request?.url)) return;
    if (event.request?.method && event.request.method.toUpperCase() !== "POST") return;
    requestId = event.requestId;
    if (logger.verbose)
      logger(`[browser] structural monitor bound conversation request ${requestId}`);
  };

  const onResponse = (event: NetworkResponseEvent): void => {
    if (stopped || event.requestId !== requestId) return;
    responseStatus = event.response?.status;
    if (logger.verbose) {
      logger(
        `[browser] structural monitor received conversation response ${String(responseStatus ?? "unknown")}`,
      );
    }
  };

  const onLoadingFinished = async (event: NetworkLoadingFinishedEvent): Promise<void> => {
    if (stopped || event.requestId !== requestId || handoff) return;
    const eventGeneration = generation;
    try {
      if (responseStatus !== undefined && (responseStatus < 200 || responseStatus >= 300)) {
        handoffSignal.resolve(null);
        return;
      }
      const body = await Network.getResponseBody({ requestId: event.requestId });
      if (stopped || eventGeneration !== generation) return;
      const text = body.base64Encoded
        ? Buffer.from(body.body, "base64").toString("utf8")
        : body.body;
      handoff = extractStreamHandoff(text);
      if (!handoff) {
        if (logger.verbose) logger("[browser] structural monitor found no Pro stream handoff");
      }
      handoffSignal.resolve(handoff);
    } catch (error) {
      if (logger.verbose) {
        logger(
          `[browser] structural monitor could not read conversation response: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      handoffSignal.resolve(null);
    }
  };

  const unsubscribe = [
    Network.requestWillBeSent(onRequest) as unknown as () => void,
    Network.responseReceived(onResponse) as unknown as () => void,
    Network.loadingFinished(onLoadingFinished) as unknown as () => void,
  ];

  const waitForCompletion = async (timeoutMs: number): Promise<ProStructuralAnswer | null> => {
    const eventGeneration = generation;
    const bootstrap = await waitWithTimeout(
      handoffSignal.promise,
      Math.min(Math.max(timeoutMs, 0), DEFAULT_BOOTSTRAP_TIMEOUT_MS),
    );
    if (!bootstrap || stopped || eventGeneration !== generation) return null;

    let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
    const deadline = Date.now() + Math.max(timeoutMs, 0);
    let lastReason = "mapping not fetched";
    while (!stopped && eventGeneration === generation && Date.now() < deadline) {
      const mappingResponse = await fetchConversationMapping(Runtime, bootstrap.conversationId);
      if (stopped || eventGeneration !== generation) return null;
      if (mappingResponse?.status === 200) {
        const mapping = mappingResponse.body?.mapping ?? {};
        pollIntervalMs = readPollInterval(mapping, bootstrap.turnExchangeId, pollIntervalMs);
        const verification = evaluateProTurnCompletion(mapping, bootstrap.turnExchangeId);
        lastReason = verification.reason ?? "verified";
        if (verification.done && verification.finalText && verification.finalMessageId) {
          return toStructuralAnswer(verification);
        }
      } else if (mappingResponse) {
        lastReason = `mapping request returned HTTP ${mappingResponse.status}`;
      }
      await delayUntilNextPoll(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    }

    if (lastReason !== "verified") {
      if (logger.verbose) logger(`[browser] structural completion inconclusive: ${lastReason}`);
    }
    return null;
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    generation += 1;
    handoffSignal.resolve(null);
    for (const remove of unsubscribe) {
      try {
        remove();
      } catch {
        // Best effort; CDP cleanup must not mask the browser result.
      }
    }
  };

  return { reset, waitForCompletion, stop };
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
): Promise<{ status: number; body?: { mapping?: ConversationMapping } } | null> {
  const expression = `(async () => {
    try {
      const response = await fetch('/backend-api/conversation/' + encodeURIComponent(${JSON.stringify(conversationId)}), {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      const text = await response.text();
      let body;
      try { body = text ? JSON.parse(text) : undefined; } catch (_error) { body = undefined; }
      return { status: response.status, body };
    } catch (_error) {
      return null;
    }
  })()`;
  const result = await Runtime.evaluate({ expression, awaitPromise: true, returnByValue: true });
  const value = result.result?.value as
    | { status?: unknown; body?: { mapping?: ConversationMapping } }
    | null
    | undefined;
  if (!value || typeof value.status !== "number") return null;
  return { status: value.status, body: value.body };
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
  return await new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

async function delayUntilNextPoll(timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
}
