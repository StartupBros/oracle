import { describe, expect, test } from "vitest";
import {
  type ConversationMapping,
  type ConversationMappingMessage,
  evaluateProTurnCompletion,
} from "../../src/browser/actions/proTurnCompletion.js";

const TURN = "turn-current";
const OTHER_TURN = "turn-someone-else";

interface MsgOptions {
  id: string;
  turn?: string;
  contentType: string;
  parts?: unknown[];
  recipient?: string;
  status?: string;
  endTurn?: boolean | null;
  reasoningStatus?: string;
  finish?: string;
  model?: string;
}

function msg(options: MsgOptions): ConversationMappingMessage {
  return {
    id: options.id,
    author: { role: "assistant" },
    recipient: options.recipient ?? "all",
    content: { content_type: options.contentType, parts: options.parts ?? [""] },
    status: options.status ?? "finished_successfully",
    end_turn: options.endTurn ?? true,
    metadata: {
      model_slug: options.model ?? "gpt-5-6-pro",
      turn_exchange_id: options.turn ?? TURN,
      ...(options.reasoningStatus ? { reasoning_status: options.reasoningStatus } : {}),
      ...(options.finish ? { finish_details: { type: options.finish } } : {}),
    },
  };
}

/** A terminal-shaped `recipient=all` text node — the only accept-eligible shape. */
function terminalText(id: string, text: string, turn = TURN): ConversationMappingMessage {
  return msg({ id, turn, contentType: "text", parts: [text], finish: "stop" });
}

function recap(id: string, turn = TURN): ConversationMappingMessage {
  return msg({
    id,
    turn,
    contentType: "reasoning_recap",
    parts: ["Recapping."],
    reasoningStatus: "reasoning_ended",
  });
}

/** Build a mapping from `[key, parent, message]` triples. */
function mapping(
  rows: Array<[string, string | null, ConversationMappingMessage | null]>,
): ConversationMapping {
  const out: ConversationMapping = {};
  for (const [key, parent, message] of rows) {
    out[key] = { id: key, parent, children: [], message };
  }
  for (const [key, parent] of rows) {
    if (parent && out[parent]) out[parent].children?.push(key);
  }
  return out;
}

describe("evaluateProTurnCompletion — documented pro-gate incident shapes", () => {
  test("S1a: a settled preamble before any recap is not completion", () => {
    // The production bug: a short preamble carries end_turn/finished_successfully
    // and visually settles, so a DOM settle-detector finalizes it as the answer.
    const map = mapping([
      ["root", null, null],
      ["think", "root", msg({ id: "m-think", contentType: "thoughts", reasoningStatus: "is_reasoning" })],
      ["preamble", "think", terminalText("m-preamble", "Sure — let me review this carefully.")],
    ]);

    expect(evaluateProTurnCompletion(map, TURN)).toEqual({
      done: false,
      reason: "trusted reasoning_ended signal not present",
    });
  });

  test("S1b: once reasoning ends, the real answer is returned and the preamble ignored", () => {
    const map = mapping([
      ["root", null, null],
      ["preamble", "root", terminalText("m-preamble", "Sure — let me review this carefully.")],
      ["think", "preamble", msg({ id: "m-think", contentType: "thoughts", reasoningStatus: "is_reasoning" })],
      ["recap", "think", recap("m-recap")],
      ["final", "recap", terminalText("m-final", "VERDICT: BLOCK — three P1 findings follow.")],
    ]);

    expect(evaluateProTurnCompletion(map, TURN)).toMatchObject({
      done: true,
      finalText: "VERDICT: BLOCK — three P1 findings follow.",
      finalMessageId: "m-final",
      finishReason: "stop",
    });
  });

  test("S2: recap followed by a terminal text is accepted", () => {
    const map = mapping([
      ["root", null, null],
      ["recap", "root", recap("m-recap")],
      ["final", "recap", terminalText("m-final", "All good.")],
    ]);

    expect(evaluateProTurnCompletion(map, TURN)).toMatchObject({
      done: true,
      finalText: "All good.",
      finalMessageId: "m-final",
    });
  });

  test("S3a: another turn's completed answer is never claimed as ours", () => {
    // The cross-bind shape: a mis-navigated render shows a finished answer that
    // belongs to a different run. Ownership is a graph field, not page text.
    const map = mapping([
      ["root", null, null],
      ["recap", "root", recap("m-recap", OTHER_TURN)],
      ["final", "recap", terminalText("m-final", "Someone else's review.", OTHER_TURN)],
    ]);

    expect(evaluateProTurnCompletion(map, TURN)).toEqual({
      done: false,
      reason: "no assistant nodes for current turn_exchange_id",
    });
  });

  test("S3b: a reused conversation returns the current turn, not the previous one", () => {
    const map = mapping([
      ["root", null, null],
      ["recap0", "root", recap("m-recap0", OTHER_TURN)],
      ["final0", "recap0", terminalText("m-final0", "Round 1 review.", OTHER_TURN)],
      ["recap1", "final0", recap("m-recap1")],
      ["final1", "recap1", terminalText("m-final1", "Round 2 review.")],
    ]);

    expect(evaluateProTurnCompletion(map, TURN)).toMatchObject({
      done: true,
      finalText: "Round 2 review.",
      finalMessageId: "m-final1",
    });
  });

  test("S4: a graph-incomparable active-reasoning sibling fails closed", () => {
    const map = mapping([
      ["root", null, null],
      ["recap", "root", recap("m-recap")],
      ["candidate", "recap", terminalText("m-candidate", "Possibly done?")],
      ["sibling", "root", msg({ id: "m-sib", contentType: "thoughts", reasoningStatus: "is_reasoning" })],
    ]);

    expect(evaluateProTurnCompletion(map, TURN)).toEqual({
      done: false,
      reason: "active or graph-incomparable reasoning remains for final text candidate",
    });
  });

  test("S5: mid-reasoning with no recap is not completion", () => {
    const map = mapping([
      ["root", null, null],
      ["think", "root", msg({ id: "m-think", contentType: "thoughts", reasoningStatus: "is_reasoning" })],
    ]);

    expect(evaluateProTurnCompletion(map, TURN)).toEqual({
      done: false,
      reason: "trusted reasoning_ended signal not present",
    });
  });

  test("S6: a non-reasoning model's answer is rejected — callers must gate dispatch", () => {
    // A turn with no reasoning_status anywhere never satisfies the contract. The
    // caller must not route non-Pro turns here, or it will poll forever.
    const map = mapping([
      ["root", null, null],
      ["final", "root", terminalText("m-final", "Instant answer.")],
    ]);

    expect(evaluateProTurnCompletion(map, TURN)).toEqual({
      done: false,
      reason: "trusted reasoning_ended signal not present",
    });
  });

  test("an empty turn id is rejected rather than matched loosely", () => {
    expect(evaluateProTurnCompletion({}, "")).toEqual({
      done: false,
      reason: "missing turn_exchange_id",
    });
  });
});

describe("evaluateProTurnCompletion — regression guards", () => {
  test("resumed reasoning vetoes a candidate regardless of its content_type", () => {
    // REGRESSION (fail-open): the veto originally allowlisted content_type
    // "thoughts"|"code", so resumed reasoning carrying any other content_type was
    // invisible and the interim text was returned as final — reproducing exactly
    // the premature-capture bug this verifier exists to prevent. The veto now keys
    // on reasoning_status alone, which is the field that actually means "still
    // reasoning"; content_type only names the node kind.
    const map = mapping([
      ["root", null, null],
      ["recap", "root", recap("m-recap")],
      ["interim", "recap", terminalText("m-interim", "Quick take: looks fine at a glance.")],
      [
        "resumed",
        "interim",
        msg({ id: "m-resumed", contentType: "reasoning", reasoningStatus: "is_reasoning" }),
      ],
    ]);

    const result = evaluateProTurnCompletion(map, TURN);
    expect(result.done).toBe(false);
    expect(result.finalText).toBeUndefined();
  });

  test("KNOWN LIMITATION: two complete branches in one turn fail closed", () => {
    // A regenerate produces two genuinely-complete recap->final branches under one
    // turn_exchange_id. ChatGPT's UI shows the newer one, but this verifier reads no
    // `current_node` pointer, so it cannot tell "abandoned branch" from "the answer
    // on screen" and rejects both. Failing closed is safe — the caller falls back to
    // its existing signal — but it is a false negative, not desired behaviour.
    // Resolving it requires plumbing `current_node` through as a tie-break.
    const map = mapping([
      ["root", null, null],
      ["recapA", "root", recap("m-recapA")],
      ["finalA", "recapA", terminalText("m-finalA", "First answer.")],
      ["recapB", "root", recap("m-recapB")],
      ["finalB", "recapB", terminalText("m-finalB", "Regenerated answer.")],
    ]);

    const result = evaluateProTurnCompletion(map, TURN);
    expect(result.done).toBe(false);
    expect(result.reason).toBe("ambiguous terminal text branches (2)");
  });
});
