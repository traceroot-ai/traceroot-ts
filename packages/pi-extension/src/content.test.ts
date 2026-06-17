import assert from "node:assert/strict";
import { test } from "node:test";
import { lastAssistantText, renderMessageContent, renderToolResult } from "./content.ts";

test("renderMessageContent passes through a string", () => {
  assert.equal(renderMessageContent("hello", 100), "hello");
});

test("renderMessageContent flattens text blocks", () => {
  const content = [
    { type: "text", text: "line one" },
    { type: "text", text: "line two" },
  ];
  assert.equal(renderMessageContent(content, 100), "line one\nline two");
});

test("renderMessageContent summarizes tool-call blocks", () => {
  const content = [
    { type: "text", text: "let me check" },
    { type: "toolCall", toolName: "bash", args: { command: "ls" } },
  ];
  assert.equal(renderMessageContent(content, 200), 'let me check\n[tool_call: bash {"command":"ls"}]');
});

test("renderMessageContent truncates with an ellipsis", () => {
  assert.equal(renderMessageContent("abcdef", 3), "abc…");
});

test("renderToolResult reads AgentToolResult content arrays", () => {
  const result = { content: [{ type: "text", text: "total 8\nfile.txt" }] };
  assert.equal(renderToolResult(result, 100), "total 8\nfile.txt");
});

test("renderToolResult handles plain strings", () => {
  assert.equal(renderToolResult("done", 100), "done");
});

test("lastAssistantText returns the final assistant message text", () => {
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "first" }] },
    { role: "toolResult", content: [{ type: "text", text: "tool" }] },
    { role: "assistant", content: [{ type: "text", text: "final answer" }] },
  ];
  assert.equal(lastAssistantText(messages, 100), "final answer");
});

test("lastAssistantText returns empty for no assistant message", () => {
  assert.equal(lastAssistantText([{ role: "user", content: "hi" }], 100), "");
});
