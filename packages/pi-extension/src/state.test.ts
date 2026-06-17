import assert from "node:assert/strict";
import { test } from "node:test";
import type { Context, Span } from "@opentelemetry/api";
import {
  activeParentCtx,
  closeAllOpenSpans,
  createSpanState,
  resetForNewSession,
  sweepTurnScoped,
} from "./state.ts";

const ended: string[] = [];

function fakeSpan(label: string): Span {
  return {
    end: () => ended.push(label),
    setAttribute: () => fakeSpan(label),
    addEvent: () => fakeSpan(label),
    spanContext: () => ({ traceId: "t", spanId: "s", traceFlags: 1 }),
  } as unknown as Span;
}

const fakeCtx = (id: string) => ({ __id: id }) as unknown as Context;

test("closeAllOpenSpans closes tools -> llm -> turn -> session in order", () => {
  ended.length = 0;
  const state = createSpanState();
  state.sessionSpan = fakeSpan("session");
  state.turnSpan = fakeSpan("turn");
  state.llmSpans.set(0, { span: fakeSpan("llm"), ctx: fakeCtx("llm"), startTime: 0, turnIndex: 0 });
  state.toolSpans.set("tc1", { span: fakeSpan("tool"), startTime: 0, toolName: "read" });

  closeAllOpenSpans(state, "quit");

  assert.deepEqual(ended, ["tool", "llm", "turn", "session"]);
  assert.equal(state.toolSpans.size, 0);
  assert.equal(state.llmSpans.size, 0);
  assert.equal(state.turnSpan, null);
  assert.equal(state.sessionSpan, null);
  assert.equal(state.currentLlmTurnIndex, null);
});

test("closeAllOpenSpans is safe with nothing open", () => {
  ended.length = 0;
  const state = createSpanState();
  closeAllOpenSpans(state, "quit");
  assert.deepEqual(ended, []);
});

test("sweepTurnScoped closes tools and LLM spans but leaves turn and session open", () => {
  ended.length = 0;
  const state = createSpanState();
  state.sessionSpan = fakeSpan("session");
  state.turnSpan = fakeSpan("turn");
  state.llmSpans.set(0, { span: fakeSpan("llm"), ctx: fakeCtx("llm"), startTime: 0, turnIndex: 0 });
  state.toolSpans.set("tc1", { span: fakeSpan("tool"), startTime: 0, toolName: "read" });
  state.currentLlmTurnIndex = 0;

  sweepTurnScoped(state);

  assert.deepEqual(ended, ["tool", "llm"]);
  assert.equal(state.toolSpans.size, 0);
  assert.equal(state.llmSpans.size, 0);
  assert.equal(state.currentLlmTurnIndex, null);
  assert.notEqual(state.turnSpan, null);
  assert.notEqual(state.sessionSpan, null);
});

test("resetForNewSession clears session identity so a fresh session span opens", () => {
  const state = createSpanState();
  state.sessionTraceId = "t";
  state.sessionFile = "/s.jsonl";
  state.sessionStartReason = "fork";
  state.forkLink = { traceId: "a", spanId: "b" };
  state.forkedFromSessionFile = "/prev.jsonl";
  state.promptIndex = 3;
  state.pendingPrompt = "hi";
  state.projectFinalized = true;

  resetForNewSession(state);

  assert.equal(state.sessionTraceId, null);
  assert.equal(state.sessionFile, null);
  assert.equal(state.sessionStartReason, null);
  assert.equal(state.forkLink, null);
  assert.equal(state.forkedFromSessionFile, null);
  assert.equal(state.promptIndex, 0);
  assert.equal(state.pendingPrompt, null);
  assert.equal(state.projectFinalized, false);
});

test("activeParentCtx prefers the open LLM span", () => {
  const state = createSpanState();
  state.sessionCtx = fakeCtx("session");
  state.turnCtx = fakeCtx("turn");
  const llmCtx = fakeCtx("llm");
  state.llmSpans.set(2, { span: fakeSpan("llm"), ctx: llmCtx, startTime: 0, turnIndex: 2 });
  state.currentLlmTurnIndex = 2;
  assert.equal(activeParentCtx(state), llmCtx);
});

test("activeParentCtx falls back to turn then session", () => {
  const state = createSpanState();
  state.sessionCtx = fakeCtx("session");
  const turnCtx = fakeCtx("turn");
  state.turnCtx = turnCtx;
  assert.equal(activeParentCtx(state), turnCtx);

  state.turnCtx = null;
  assert.equal((activeParentCtx(state) as unknown as { __id: string }).__id, "session");
});
