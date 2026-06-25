import assert from "node:assert/strict";
import { test } from "node:test";
import type { Span, Tracer } from "@opentelemetry/api";
import { createSpanState } from "../state.ts";
import { registerLlm, resolveModel } from "./llm.ts";
import type { Runtime } from "../runtime.ts";
import type { ExtensionContext } from "../types.ts";

const ended: string[] = [];

function fakeSpan(label: string): Span {
  return {
    end: () => ended.push(label),
    setAttribute: () => fakeSpan(label),
    addEvent: () => fakeSpan(label),
    spanContext: () => ({ traceId: "t", spanId: "s", traceFlags: 1 }),
  } as unknown as Span;
}

function fakeRuntime() {
  let n = 0;
  const handlers = new Map<string, (raw: unknown, ctx?: unknown) => unknown>();
  const tracer = { startSpan: () => fakeSpan(`span${n++}`) } as unknown as Tracer;
  const pi = { on: (event: string, h: (raw: unknown, ctx?: unknown) => unknown) => handlers.set(event, h) };
  const rt = {
    pi,
    state: createSpanState(),
    config: { captureFullPayload: false },
    tracer,
    debug: () => {},
  } as unknown as Runtime;
  return { rt, handlers };
}

test("resolveModel prefers live ctx.model over the cached selection", () => {
  const rt = { state: { currentModel: { provider: "openai", id: "gpt-4o" } } } as unknown as Runtime;
  const ctx = { model: { provider: "anthropic", id: "claude" } } as unknown as ExtensionContext;
  assert.deepEqual(resolveModel(rt, ctx), { provider: "anthropic", id: "claude" });
});

test("resolveModel falls back to the cached selection when ctx omits the model", () => {
  const rt = { state: { currentModel: { provider: "openai", id: "gpt-4o" } } } as unknown as Runtime;
  assert.deepEqual(resolveModel(rt, undefined), { provider: "openai", id: "gpt-4o" });
  const ctxNoModel = {} as unknown as ExtensionContext;
  assert.deepEqual(resolveModel(rt, ctxNoModel), { provider: "openai", id: "gpt-4o" });
});

test("resolveModel returns null when neither source has a model", () => {
  const rt = { state: { currentModel: null } } as unknown as Runtime;
  assert.equal(resolveModel(rt, undefined), null);
});

test("turn_start ends a prior open LLM span at the same turnIndex instead of leaking it", async () => {
  ended.length = 0;
  const { rt, handlers } = fakeRuntime();
  registerLlm(rt);
  const turnStart = handlers.get("turn_start");
  if (!turnStart) throw new Error("turn_start handler not registered");
  const ctx = { model: { provider: "openai", id: "gpt-4o" } };

  await turnStart({ turnIndex: 0 }, ctx);
  assert.equal(rt.state.llmSpans.size, 1);
  assert.equal(ended.length, 0);

  // A second turn_start at the same index (pi re-emitting, or two absent indices
  // both defaulting to -1) must close the first span, not orphan it out of the map.
  await turnStart({ turnIndex: 0 }, ctx);
  assert.equal(ended.length, 1, "the first span should be ended before being replaced");
  assert.equal(rt.state.llmSpans.size, 1, "exactly one span remains tracked");
});
