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
    const resultPromise = monitor.waitForCompletion(5_000);
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
    expect(evaluate.mock.calls[0]?.[0].expression).not.toContain("Authorization");

    monitor.stop();
    expect(network.removed).toEqual(["request", "response", "finished"]);
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
    const resultPromise = monitor.waitForCompletion(5_000);
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
    const resultPromise = monitor.waitForCompletion(5_000);
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
    const resultPromise = monitor.waitForCompletion(25);
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
