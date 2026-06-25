import assert from "node:assert/strict";
import { test } from "node:test";
import { browserLaunch } from "./command.ts";

const URL = "https://app.traceroot.ai/trace/abc?traceId=deadbeef";

test("browserLaunch routes Windows through cmd.exe, not the `start` builtin", () => {
  const launch = browserLaunch("win32", URL);
  // `start` is a cmd builtin, not an executable on PATH; spawning it directly
  // fails with ENOENT. The empty "" is start's title arg so the URL is not
  // consumed as a window title.
  assert.deepEqual(launch, { command: "cmd", args: ["/c", "start", "", URL] });
});

test("browserLaunch uses `open` on macOS", () => {
  assert.deepEqual(browserLaunch("darwin", URL), { command: "open", args: [URL] });
});

test("browserLaunch uses `xdg-open` on Linux", () => {
  assert.deepEqual(browserLaunch("linux", URL), { command: "xdg-open", args: [URL] });
});

test("browserLaunch returns null on unsupported platforms", () => {
  assert.equal(browserLaunch("freebsd", URL), null);
  assert.equal(browserLaunch("aix", URL), null);
});
