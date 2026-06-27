import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserLaunch, isLaunchableUrl } from './command.ts';

const URL = 'https://app.traceroot.ai/trace/abc?traceId=deadbeef';

test('isLaunchableUrl accepts clean http(s) URLs and rejects injection/non-http', () => {
  assert.equal(isLaunchableUrl(URL), true);
  assert.equal(isLaunchableUrl('http://localhost:3000/projects/p/traces?traceId=t'), true);
  // cmd.exe shell-operator injection attempts must be rejected.
  assert.equal(isLaunchableUrl('http://x&calc'), false);
  assert.equal(isLaunchableUrl('http://x|whoami'), false);
  assert.equal(isLaunchableUrl('http://x>out'), false);
  assert.equal(isLaunchableUrl('http://x y'), false); // whitespace
  // Non-http(s) schemes must be rejected.
  assert.equal(isLaunchableUrl('file:///etc/passwd'), false);
  assert.equal(isLaunchableUrl('javascript:alert(1)'), false);
  assert.equal(isLaunchableUrl('not a url'), false);
});

test('browserLaunch routes Windows through cmd.exe, not the `start` builtin', () => {
  const launch = browserLaunch('win32', URL);
  // `start` is a cmd builtin, not an executable on PATH; spawning it directly
  // fails with ENOENT. The empty "" is start's title arg so the URL is not
  // consumed as a window title.
  assert.deepEqual(launch, { command: 'cmd', args: ['/c', 'start', '', URL] });
});

test('browserLaunch uses `open` on macOS', () => {
  assert.deepEqual(browserLaunch('darwin', URL), { command: 'open', args: [URL] });
});

test('browserLaunch uses `xdg-open` on Linux', () => {
  assert.deepEqual(browserLaunch('linux', URL), { command: 'xdg-open', args: [URL] });
});

test('browserLaunch returns null on unsupported platforms', () => {
  assert.equal(browserLaunch('freebsd', URL), null);
  assert.equal(browserLaunch('aix', URL), null);
});
