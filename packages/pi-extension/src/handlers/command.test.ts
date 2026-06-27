import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserLaunch, isLaunchableUrl, registerCommand } from './command.ts';
import { commandRuntime } from '../test-support.ts';

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

// ---------------------------------------------------------------------------
// /traceroot command subcommands
// ---------------------------------------------------------------------------

test('/traceroot flush reports nothing-to-flush once the provider is shut down', async () => {
  const { rt, run, notifications, providerCalls } = commandRuntime({ providerShutdown: true });
  registerCommand(rt);
  await run('flush');
  assert.equal(providerCalls.flush, 0, 'no flush is attempted against a dead provider');
  assert.ok(
    notifications.some((n) => /shut down|nothing to flush/i.test(n.message)),
    'the user is told tracing has shut down',
  );
});

test('/traceroot flush forwards to the provider when it is live', async () => {
  const { rt, run, notifications, providerCalls } = commandRuntime();
  registerCommand(rt);
  await run('flush');
  assert.equal(providerCalls.flush, 1, 'a live provider is flushed');
  assert.ok(notifications.some((n) => /flushed/i.test(n.message)));
});

test('/traceroot flush reports a failure when the provider flush rejects', async () => {
  const { rt, run, notifications } = commandRuntime();
  (rt.provider as unknown as { forceFlush: () => Promise<void> }).forceFlush = async () => {
    throw new Error('backend unreachable');
  };
  registerCommand(rt);
  await run('flush');
  assert.ok(
    notifications.some((n) => n.level === 'error' && /flush failed/i.test(n.message)),
    'a failed flush is surfaced as an error, not silently swallowed',
  );
});

test('/traceroot disable then enable toggles sessionDisabled', async () => {
  const { rt, run } = commandRuntime();
  registerCommand(rt);
  await run('disable');
  assert.equal(rt.state.sessionDisabled, true, 'disable turns tracing off for the session');
  await run('enable');
  assert.equal(rt.state.sessionDisabled, false, 'enable turns it back on');
});

test('/traceroot status reports config and session state', async () => {
  const { rt, run, notifications } = commandRuntime();
  registerCommand(rt);
  await run('status');
  const status = notifications.at(-1)?.message ?? '';
  assert.match(status, /enabled=true/);
  assert.match(status, /project=pi/);
  assert.match(status, /session=active/);
});

test('/traceroot with no/unknown subcommand defaults to status, an explicit junk arg shows usage', async () => {
  const noArg = commandRuntime();
  registerCommand(noArg.rt);
  await noArg.run('');
  assert.match(
    noArg.notifications.at(-1)?.message ?? '',
    /enabled=/,
    'empty arg defaults to status',
  );

  const junk = commandRuntime();
  registerCommand(junk.rt);
  await junk.run('wat');
  assert.match(
    junk.notifications.at(-1)?.message ?? '',
    /usage/i,
    'an unknown subcommand shows usage',
  );
});
