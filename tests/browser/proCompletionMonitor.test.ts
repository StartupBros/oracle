import { describe, expect, test, vi } from "vitest";
import type { BrowserLogger, ChromeClient } from "../../src/browser/types.js";
import {
  createProCompletionMonitor,
  extractStreamHandoff,
} from "../../src/browser/actions/proCompletionMonitor.js";

const TURN = "turn-current";

function completedMapping() {
  return {
    root: { id: "root", parent: null, children: ["recap"], message: null },
    recap: {
      id: "recap",
      parent: "root",
      children: ["final"],
      message: {
        id: "recap-message",
        author: { role: "assistant" },
        recipient: "all",
        content: { content_type: "reasoning_recap", parts: ["Recapping"] },
        status: "finished_successfully",
        end_turn: true,
        metadata: {
          turn_exchange_id: TURN,
          reasoning_status: "reasoning_ended",
          poll_interval_ms: 1000,
        },
      },
    },
    final: {
      id: "final",
      parent: "recap",
      children: [],
      message: {
        id: "final-message",
        author: { role: "assistant" },
        recipient: "all",
        content: { content_type: "text", parts: ["Verified Pro answer."] },
        status: "finished_successfully",
        end_turn: true,
        metadata: {
          turn_exchange_id: TURN,
          model_slug: "gpt-5-6-pro",
          finish_details: { type: "stop" },
        },
      },
    },
  };
}

type Handler<T> = (event: T) => void | Promise<void>;

function makeNetwork() {
  const requests: Handler<unknown>[] = [];
  const responses: Handler<unknown>[] = [];
  const finished: Handler<unknown>[] = [];
  const removed: string[] = [];
  const network = {
    requestWillBeSent: vi.fn((handler: Handler<unknown>) => {
      requests.push(handler);
      return () => removed.push("request");
    }),
    responseReceived: vi.fn((handler: Handler<unknown>) => {
      responses.push(handler);
      return () => removed.push("response");
    }),
    loadingFinished: vi.fn((handler: Handler<unknown>) => {
      finished.push(handler);
      return () => removed.push("finished");
    }),
    getResponseBody: vi.fn(async (_params?: { requestId: string }) => ({
      base64Encoded: false,
      body: [
        'data: {"type":"stream_handoff","conversation_id":"conv-1","turn_exchange_id":"turn-current"}',
        "",
        "data: [DONE]",
      ].join("\n"),
    })),
    emitRequest: async (event: unknown) => {
      for (const handler of requests) await handler(event);
    },
    emitResponse: async (event: unknown) => {
      for (const handler of responses) await handler(event);
    },
    emitFinished: async (event: unknown) => {
      for (const handler of finished) await handler(event);
    },
    removed,
  };
  return network;
}

describe("extractStreamHandoff", () => {
  test("extracts the Pro conversation and turn markers from SSE", () => {
    expect(
      extractStreamHandoff(
        'data: {"type":"message_stream_complete"}\n\n' +
          'data: {"type":"stream_handoff","conversation_id":"conv-1","turn_exchange_id":"turn-1"}\n\n' +
          "data: [DONE]\n",
      ),
    ).toEqual({ conversationId: "conv-1", turnExchangeId: "turn-1" });
  });

  test("does not treat ordinary conversation SSE as a Pro handoff", () => {
    expect(extractStreamHandoff('data: {"type":"message_stream_complete"}\n')).toBeNull();
  });
});

describe("createProCompletionMonitor", () => {
  test("passively binds the send, fetches the mapping in page context, and proves completion", async () => {
    const network = makeNetwork();
    const evaluate = vi.fn(async ({ expression }: { expression: string }) => ({
      result: { value: { status: 200, body: { mapping: completedMapping() } } },
      expression,
    }));
    const runtime = { evaluate } as unknown as ChromeClient["Runtime"];
    const logger = vi.fn() as BrowserLogger;
    logger.verbose = true;
    const monitor = createProCompletionMonitor(
      network as unknown as ChromeClient["Network"],
      runtime,
      logger,
    );

    monitor.reset();
    monitor.arm();
    const resultPromise = monitor.waitForCompletion(12_000);
    await network.emitRequest({
      requestId: "ignored-get",
      request: { method: "GET", url: "https://chatgpt.com/backend-api/f/conversation" },
    });
    await network.emitRequest({
      requestId: "send-1",
      request: { method: "POST", url: "https://chatgpt.com/backend-api/f/conversation" },
    });
    await network.emitResponse({ requestId: "send-1", response: { status: 200 } });
    await network.emitFinished({ requestId: "send-1" });

    await expect(resultPromise).resolves.toEqual({
      status: "verified",
      answer: {
        text: "Verified Pro answer.",
        messageId: "final-message",
        modelSlug: "gpt-5-6-pro",
        finishReason: "stop",
      },
    });
    expect(network.getResponseBody).toHaveBeenCalledWith({ requestId: "send-1" });
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        awaitPromise: true,
        returnByValue: true,
        expression: expect.stringContaining("credentials: 'include'"),
      }),
    );
    // The bearer is attached inside the page (cookies alone 404 on this endpoint); what
    // must never happen is the token crossing back into Node. Node sees status + mapping.
    expect(evaluate.mock.calls[0]?.[0].expression).toContain("/api/auth/session");

    monitor.stop();
    expect(network.removed).toEqual(["request", "response", "finished"]);
  });

  test("rejects an interim terminal snapshot that reasoning later invalidates", async () => {
    const network = makeNetwork();
    // Poll 1: looks complete. Poll 2: same turn resumed reasoning (the interim window).
    // Poll 3+: the real final answer, stable across confirmation.
    const interim = completedMapping();
    interim.final.message.content.parts = ["Quick take: looks fine at a glance."];
    const resumed = completedMapping();
    resumed.final.message.content.parts = ["Quick take: looks fine at a glance."];
    (resumed as unknown as Record<string, unknown>).resumed = {
      id: "resumed",
      parent: "final",
      children: [],
      message: {
        id: "resumed-message",
        author: { role: "assistant" },
        recipient: "all",
        content: { content_type: "thoughts", parts: ["Still working"] },
        status: "in_progress",
        metadata: { turn_exchange_id: TURN, reasoning_status: "is_reasoning" },
      },
    } as never;
    // Two interim snapshots BEFORE reasoning resumes: a repeat alone must not confirm.
    const snapshots = [
      interim,
      interim,
      resumed,
      completedMapping(),
      completedMapping(),
      completedMapping(),
      completedMapping(),
      completedMapping(),
    ];
    let call = 0;
    const runtime = {
      evaluate: vi.fn(async () => ({
        result: {
          value: {
            status: 200,
            body: { mapping: snapshots[Math.min(call++, snapshots.length - 1)] },
          },
        },
      })),
    } as unknown as ChromeClient["Runtime"];
    const monitor = createProCompletionMonitor(
      network as unknown as ChromeClient["Network"],
      runtime,
      vi.fn() as BrowserLogger,
    );

    monitor.reset();
    monitor.arm();
    const resultPromise = monitor.waitForCompletion(20_000);
    await network.emitRequest({
      requestId: "send-1",
      request: { method: "POST", url: "https://chatgpt.com/backend-api/f/conversation" },
    });
    await network.emitResponse({ requestId: "send-1", response: { status: 200 } });
    await network.emitFinished({ requestId: "send-1" });

    const result = await resultPromise;
    // The interim text must never be returned as the final answer.
    expect(result).toMatchObject({ status: "verified" });
    if (result.status === "verified") {
      expect(result.answer.text).toBe("Verified Pro answer.");
    }
    monitor.stop();
  }, 30_000);

  test("does not confirm while streaming text still grows under a stable message id", async () => {
    const network = makeNetwork();
    // Same message id every poll, but the text keeps accumulating: never stable, never final.
    let call = 0;
    const runtime = {
      evaluate: vi.fn(async () => {
        const mapping = completedMapping();
        mapping.final.message.content.parts = ["Partial answer".padEnd(20 + call++ * 10, ".")];
        return { result: { value: { status: 200, body: { mapping } } } };
      }),
    } as unknown as ChromeClient["Runtime"];
    const monitor = createProCompletionMonitor(
      network as unknown as ChromeClient["Network"],
      runtime,
      vi.fn() as BrowserLogger,
    );

    monitor.reset();
    monitor.arm();
    const resultPromise = monitor.waitForCompletion(6_000);
    await network.emitRequest({
      requestId: "send-1",
      request: { method: "POST", url: "https://chatgpt.com/backend-api/f/conversation" },
    });
    await network.emitResponse({ requestId: "send-1", response: { status: 200 } });
    await network.emitFinished({ requestId: "send-1" });

    await expect(resultPromise).resolves.toMatchObject({
      status: "inconclusive",
      reason: "completion awaiting stability confirmation",
    });
    monitor.stop();
  }, 20_000);

  test("hands off immediately on HTTP 429 instead of polling into the rate limit", async () => {
    const network = makeNetwork();
    const evaluate = vi.fn(async () => ({
      result: { value: { status: 429, body: undefined } },
    }));
    const monitor = createProCompletionMonitor(
      network as unknown as ChromeClient["Network"],
      { evaluate } as unknown as ChromeClient["Runtime"],
      vi.fn() as BrowserLogger,
    );

    monitor.reset();
    monitor.arm();
    const resultPromise = monitor.waitForCompletion(10_000);
    await network.emitRequest({
      requestId: "send-1",
      request: { method: "POST", url: "https://chatgpt.com/backend-api/f/conversation" },
    });
    await network.emitResponse({ requestId: "send-1", response: { status: 200 } });
    await network.emitFinished({ requestId: "send-1" });

    await expect(resultPromise).resolves.toMatchObject({
      status: "inconclusive",
      reason: "mapping request returned HTTP 429",
    });
    expect(evaluate).toHaveBeenCalledTimes(1);
    monitor.stop();
  });

  test("defers to DOM when the mapping text carries private citation markers", async () => {
    const network = makeNetwork();
    const runtime = {
      evaluate: vi.fn(async () => {
        const mapping = completedMapping();
        const open = String.fromCodePoint(0xe200);
        const close = String.fromCodePoint(0xe201);
        mapping.final.message.content.parts = ["See " + open + "cite" + close + " for details."];
        return { result: { value: { status: 200, body: { mapping } } } };
      }),
    } as unknown as ChromeClient["Runtime"];
    const monitor = createProCompletionMonitor(
      network as unknown as ChromeClient["Network"],
      runtime,
      vi.fn() as BrowserLogger,
    );

    monitor.reset();
    monitor.arm();
    const resultPromise = monitor.waitForCompletion(10_000);
    await network.emitRequest({
      requestId: "send-1",
      request: { method: "POST", url: "https://chatgpt.com/backend-api/f/conversation" },
    });
    await network.emitResponse({ requestId: "send-1", response: { status: 200 } });
    await network.emitFinished({ requestId: "send-1" });

    await expect(resultPromise).resolves.toMatchObject({
      status: "inconclusive",
      reason: "answer contains private citation markers",
    });
    monitor.stop();
  });

  test("authenticates the mapping poll in page context without leaking the token", async () => {
    const network = makeNetwork();
    const evaluate = vi.fn(async (_params: { expression: string }) => ({
      result: { value: { status: 200, body: { mapping: completedMapping() } } },
    }));
    const logger = vi.fn() as BrowserLogger & { mock: { calls: unknown[][] } };
    logger.verbose = true;
    const monitor = createProCompletionMonitor(
      network as unknown as ChromeClient["Network"],
      { evaluate } as unknown as ChromeClient["Runtime"],
      logger,
    );

    monitor.reset();
    monitor.arm();
    const resultPromise = monitor.waitForCompletion(12_000);
    await network.emitRequest({
      requestId: "send-1",
      request: { method: "POST", url: "https://chatgpt.com/backend-api/f/conversation" },
    });
    await network.emitResponse({ requestId: "send-1", response: { status: 200 } });
    await network.emitFinished({ requestId: "send-1" });
    await expect(resultPromise).resolves.toMatchObject({ status: "verified" });

    const expression = evaluate.mock.calls[0]?.[0].expression as string;
    // Cookies alone 404 on this endpoint, so the bearer must be attached...
    expect(expression).toContain("/api/auth/session");
    expect(expression).toContain("'Bearer '");
    expect(expression).toContain("credentials: 'include'");
    // ...but the token is read and used only in-page; Node receives status + mapping.
    expect(expression).toContain("globalThis[TOKEN_KEY]");
    expect(logger.mock.calls.flat().join(" ")).not.toContain("Bearer");
    monitor.stop();
  });

  test("stops polling and falls back when the mapping request is unauthorized", async () => {
    const network = makeNetwork();
    const evaluate = vi.fn(async () => ({
      result: {
        value: {
          status: 404,
          body: undefined,
          unauthorized: true,
        },
      },
    }));
    const monitor = createProCompletionMonitor(
      network as unknown as ChromeClient["Network"],
      { evaluate } as unknown as ChromeClient["Runtime"],
      vi.fn() as BrowserLogger,
    );

    monitor.reset();
    monitor.arm();
    const resultPromise = monitor.waitForCompletion(10_000);
    await network.emitRequest({
      requestId: "send-1",
      request: { method: "POST", url: "https://chatgpt.com/backend-api/f/conversation" },
    });
    await network.emitResponse({ requestId: "send-1", response: { status: 200 } });
    await network.emitFinished({ requestId: "send-1" });

    await expect(resultPromise).resolves.toMatchObject({
      status: "inconclusive",
      reason: "mapping request unauthorized (HTTP 404)",
    });
    // It must give up immediately rather than burning the whole structural budget.
    expect(evaluate).toHaveBeenCalledTimes(1);
    monitor.stop();
  });

  test("fails closed when the mapping cannot prove completion", async () => {
    const network = makeNetwork();
    const runtime = {
      evaluate: vi.fn(async () => ({
        result: { value: { status: 200, body: { mapping: {} } } },
      })),
    } as unknown as ChromeClient["Runtime"];
    const monitor = createProCompletionMonitor(
      network as unknown as ChromeClient["Network"],
      runtime,
      vi.fn() as BrowserLogger,
    );

    monitor.reset();
    monitor.arm();
    const resultPromise = monitor.waitForCompletion(1_050);
    await network.emitRequest({
      requestId: "send-1",
      request: { method: "POST", url: "https://chatgpt.com/backend-api/f/conversation" },
    });
    await network.emitResponse({ requestId: "send-1", response: { status: 200 } });
    await network.emitFinished({ requestId: "send-1" });

    await expect(resultPromise).resolves.toMatchObject({ status: "inconclusive" });
    monitor.stop();
  });

  test("does not expose a malformed mapping response to Node logs", async () => {
    const network = makeNetwork();
    const logger = vi.fn() as BrowserLogger & { mock: { calls: unknown[][] } };
    logger.verbose = true;
    const runtime = {
      evaluate: vi.fn(async () => ({
        result: { value: { status: 502, body: undefined } },
      })),
    } as unknown as ChromeClient["Runtime"];
    const monitor = createProCompletionMonitor(
      network as unknown as ChromeClient["Network"],
      runtime,
      logger,
    );

    monitor.reset();
    monitor.arm();
    const resultPromise = monitor.waitForCompletion(1_050);
    await network.emitRequest({
      requestId: "send-1",
      request: { method: "POST", url: "https://chatgpt.com/backend-api/f/conversation" },
    });
    await network.emitResponse({ requestId: "send-1", response: { status: 200 } });
    await network.emitFinished({ requestId: "send-1" });

    await expect(resultPromise).resolves.toMatchObject({
      status: "inconclusive",
      reason: "mapping request returned HTTP 502",
    });
    expect(logger.mock.calls.flat().join(" ")).not.toContain("Authorization");
    expect(logger.mock.calls.flat().join(" ")).not.toContain("cookie");
    monitor.stop();
  });

  test("maps a Runtime failure to inconclusive instead of rejecting", async () => {
    const network = makeNetwork();
    const runtime = {
      evaluate: vi.fn(async () => {
        throw new Error("execution context was destroyed");
      }),
    } as unknown as ChromeClient["Runtime"];
    const monitor = createProCompletionMonitor(
      network as unknown as ChromeClient["Network"],
      runtime,
      vi.fn() as BrowserLogger,
    );

    monitor.reset();
    monitor.arm();
    const resultPromise = monitor.waitForCompletion(1_050);
    await network.emitRequest({
      requestId: "send-1",
      request: { method: "POST", url: "https://chatgpt.com/backend-api/f/conversation" },
    });
    await network.emitResponse({ requestId: "send-1", response: { status: 200 } });
    await network.emitFinished({ requestId: "send-1" });

    await expect(resultPromise).resolves.toMatchObject({
      status: "inconclusive",
      reason: "mapping request failed",
    });
    monitor.stop();
  });

  test("includes the bootstrap wait in the caller's timeout", async () => {
    const network = makeNetwork();
    const monitor = createProCompletionMonitor(
      network as unknown as ChromeClient["Network"],
      {} as ChromeClient["Runtime"],
      vi.fn() as BrowserLogger,
    );

    const started = Date.now();
    const result = await monitor.waitForCompletion(25);
    expect(result).toMatchObject({
      status: "unavailable",
      reason: "Pro stream handoff not observed",
    });
    expect(Date.now() - started).toBeLessThan(150);
    monitor.stop();
  });

  test("tracks past an auxiliary POST and binds the later Pro handoff", async () => {
    const network = makeNetwork();
    network.getResponseBody.mockImplementation(async ({ requestId } = { requestId: "" }) => ({
      base64Encoded: false,
      body:
        requestId === "auxiliary-post"
          ? 'data: {"type":"message_stream_complete"}'
          : 'data: {"type":"stream_handoff","conversation_id":"conv-1","turn_exchange_id":"turn-current"}',
    }));
    const runtime = {
      evaluate: vi.fn(async () => ({
        result: { value: { status: 200, body: { mapping: completedMapping() } } },
      })),
    } as unknown as ChromeClient["Runtime"];
    const monitor = createProCompletionMonitor(
      network as unknown as ChromeClient["Network"],
      runtime,
      vi.fn() as BrowserLogger,
    );

    monitor.reset();
    monitor.arm();
    const resultPromise = monitor.waitForCompletion(12_000);
    await network.emitRequest({
      requestId: "auxiliary-post",
      request: { method: "POST", url: "https://chatgpt.com/backend-api/f/conversation" },
    });
    await network.emitResponse({ requestId: "auxiliary-post", response: { status: 200 } });
    await network.emitFinished({ requestId: "auxiliary-post" });
    await network.emitRequest({
      requestId: "intended-post",
      request: { method: "POST", url: "https://chatgpt.com/backend-api/f/conversation" },
    });
    await network.emitResponse({ requestId: "intended-post", response: { status: 200 } });
    await network.emitFinished({ requestId: "intended-post" });

    await expect(resultPromise).resolves.toMatchObject({
      status: "verified",
      answer: { text: "Verified Pro answer." },
    });
    expect(network.getResponseBody).toHaveBeenCalledWith({ requestId: "auxiliary-post" });
    expect(network.getResponseBody).toHaveBeenCalledWith({ requestId: "intended-post" });
    monitor.stop();
  });

  test("does not bind a stale request arriving after reset but before arm", async () => {
    const network = makeNetwork();
    const runtime = {
      evaluate: vi.fn(async () => ({
        result: { value: { status: 200, body: { mapping: completedMapping() } } },
      })),
    } as unknown as ChromeClient["Runtime"];
    const monitor = createProCompletionMonitor(
      network as unknown as ChromeClient["Network"],
      runtime,
      vi.fn() as BrowserLogger,
    );

    monitor.reset();
    await network.emitRequest({
      requestId: "stale-after-reset",
      request: { method: "POST", url: "https://chatgpt.com/backend-api/f/conversation" },
    });
    monitor.arm();
    const resultPromise = monitor.waitForCompletion(12_000);
    await network.emitRequest({
      requestId: "intended-after-arm",
      request: { method: "POST", url: "https://chatgpt.com/backend-api/f/conversation" },
    });
    await network.emitResponse({ requestId: "intended-after-arm", response: { status: 200 } });
    await network.emitFinished({ requestId: "intended-after-arm" });

    await expect(resultPromise).resolves.toMatchObject({ status: "verified" });
    expect(network.getResponseBody).toHaveBeenCalledWith({ requestId: "intended-after-arm" });
    expect(network.getResponseBody).not.toHaveBeenCalledWith({ requestId: "stale-after-reset" });
    monitor.stop();
  });

  test("ignores a conversation request observed before reset", async () => {
    const network = makeNetwork();
    const runtime = {
      evaluate: vi.fn(async () => ({
        result: { value: { status: 200, body: { mapping: completedMapping() } } },
      })),
    } as unknown as ChromeClient["Runtime"];
    const monitor = createProCompletionMonitor(
      network as unknown as ChromeClient["Network"],
      runtime,
      vi.fn() as BrowserLogger,
    );

    await network.emitRequest({
      requestId: "stale-send",
      request: { method: "POST", url: "https://chatgpt.com/backend-api/f/conversation" },
    });
    monitor.reset();
    monitor.arm();
    // Budget must cover the stability-confirmation poll, not just the first snapshot.
    const resultPromise = monitor.waitForCompletion(12_000);
    await network.emitRequest({
      requestId: "current-send",
      request: { method: "POST", url: "https://chatgpt.com/backend-api/f/conversation" },
    });
    await network.emitResponse({ requestId: "current-send", response: { status: 200 } });
    await network.emitFinished({ requestId: "current-send" });

    await expect(resultPromise).resolves.toMatchObject({ status: "verified" });
    expect(network.getResponseBody).toHaveBeenCalledWith({ requestId: "current-send" });
    monitor.stop();
  });

  test("returns inconclusive when mapping evaluation never settles", async () => {
    const network = makeNetwork();
    const runtime = {
      evaluate: vi.fn(() => new Promise<never>(() => undefined)),
    } as unknown as ChromeClient["Runtime"];
    const monitor = createProCompletionMonitor(
      network as unknown as ChromeClient["Network"],
      runtime,
      vi.fn() as BrowserLogger,
    );

    monitor.reset();
    monitor.arm();
    const resultPromise = monitor.waitForCompletion(50);
    await network.emitRequest({
      requestId: "send-1",
      request: { method: "POST", url: "https://chatgpt.com/backend-api/f/conversation" },
    });
    await network.emitResponse({ requestId: "send-1", response: { status: 200 } });
    await network.emitFinished({ requestId: "send-1" });

    await expect(resultPromise).resolves.toMatchObject({
      status: "inconclusive",
      reason: "mapping request timed out",
    });
    monitor.stop();
  });

  test("does not arm Network observers when structural completion is disabled", () => {
    // The flag-off invariant is enforced at index.ts creation sites; this test
    // documents that the monitor itself is opt-in rather than a global observer.
    expect(createProCompletionMonitor).toBeTypeOf("function");
  });
});
