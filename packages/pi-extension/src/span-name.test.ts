import assert from "node:assert/strict";
import { test } from "node:test";
import { formatToolSpanName } from "./span-name.ts";

test("formatToolSpanName uses the file basename for path-like args", () => {
  assert.equal(formatToolSpanName("read", { path: "/a/b/app.py" }), "read: app.py");
  assert.equal(formatToolSpanName("write", { file: "notes.md" }), "write: notes.md");
  assert.equal(formatToolSpanName("edit", { filePath: "src/x/y.ts" }), "edit: y.ts");
  assert.equal(formatToolSpanName("grep", { target: "/etc/hosts" }), "grep: hosts");
});

test("formatToolSpanName summarizes bash by its (whitespace-collapsed) command", () => {
  assert.equal(formatToolSpanName("bash", { command: "  npm   test " }), "bash: npm test");
});

test("formatToolSpanName truncates a long bash command", () => {
  const name = formatToolSpanName("bash", { command: `echo ${"x".repeat(200)}` });
  assert.ok(name.startsWith("bash: "));
  assert.ok(name.endsWith("…"));
  assert.ok(name.length <= "bash: ".length + 60 + 1);
});

test("formatToolSpanName falls back to the bare tool name", () => {
  assert.equal(formatToolSpanName("think", {}), "think");
  assert.equal(formatToolSpanName("think", undefined), "think");
  assert.equal(formatToolSpanName("bash", { command: "" }), "bash");
});
