import { Agent } from '@cursor/sdk';
import dotenv from 'dotenv';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = resolve(__dirname, '../../fixtures');
// ENV_PATH: dotenv reads .env from process.cwd() by default

dotenv.config();

const apiKey = process.env.CURSOR_API_KEY;
if (!apiKey) {
  console.error('[capture] CURSOR_API_KEY not found in environment or .env at cwd');
  process.exit(1);
}

const scenario = process.argv[2];
if (!scenario) {
  console.error('[capture] Usage: tsx src/capture.ts <scenario>');
  console.error(
    '[capture] Scenarios: local-quickstart | local-multiturn | local-cancelled | local-errored',
  );
  process.exit(1);
}

interface CapturedEvent {
  source: 'stream' | 'onDelta' | 'onStep' | 'onDidChangeStatus';
  ts_ms: number;
  ordinal: number;
  payload: unknown;
}

const events: CapturedEvent[] = [];
let ordinal = 0;
const record = (source: CapturedEvent['source'], payload: unknown): void => {
  events.push({ source, ts_ms: Date.now(), ordinal: ordinal++, payload });
};

async function flush(label: string): Promise<void> {
  await mkdir(FIXTURES_DIR, { recursive: true });
  const path = resolve(FIXTURES_DIR, `${label}.json`);
  await writeFile(path, JSON.stringify(events, null, 2));
  console.log(`\n[capture] ${events.length} events -> ${path}`);
}

async function makeAgent(name: string): Promise<unknown> {
  return Agent.create({
    apiKey: apiKey!,
    name,
    model: { id: process.env.CURSOR_MODEL ?? 'composer-2' },
    local: { cwd: process.cwd() },
  } as any);
}

async function localQuickstart(): Promise<void> {
  const agent = (await makeAgent('fixture-local-quickstart')) as any;
  const run = await agent.send(
    "List the files in this directory and summarize what's here in one short paragraph.",
    {
      onDelta: ({ update }: any) => record('onDelta', update),
      onStep: ({ step }: any) => record('onStep', step),
    },
  );
  run.onDidChangeStatus?.((status: any) => record('onDidChangeStatus', { status }));
  for await (const event of run.stream()) record('stream', event);
  await run.wait?.();
}

async function localMultiturn(): Promise<void> {
  const agent = (await makeAgent('fixture-local-multiturn')) as any;

  const run1 = await agent.send("What's in this folder?", {
    onDelta: ({ update }: any) => record('onDelta', { turn: 1, update }),
    onStep: ({ step }: any) => record('onStep', { turn: 1, step }),
  });
  run1.onDidChangeStatus?.((status: any) => record('onDidChangeStatus', { turn: 1, status }));
  for await (const event of run1.stream()) record('stream', { turn: 1, event });
  await run1.wait?.();

  const run2 = await agent.send('Now count how many .ts files there are.', {
    onDelta: ({ update }: any) => record('onDelta', { turn: 2, update }),
    onStep: ({ step }: any) => record('onStep', { turn: 2, step }),
  });
  run2.onDidChangeStatus?.((status: any) => record('onDidChangeStatus', { turn: 2, status }));
  for await (const event of run2.stream()) record('stream', { turn: 2, event });
  await run2.wait?.();
}

async function localCancelled(): Promise<void> {
  const agent = (await makeAgent('fixture-local-cancelled')) as any;
  const run = await agent.send(
    'Refactor every file in this directory to use async/await and explain each change in detail.',
    {
      onDelta: ({ update }: any) => record('onDelta', update),
      onStep: ({ step }: any) => record('onStep', step),
    },
  );
  run.onDidChangeStatus?.((status: any) => record('onDidChangeStatus', { status }));

  const cancelTimer = setTimeout(() => {
    record('stream', { __injected: 'cancel-call-issued' });
    try {
      run.cancel?.();
    } catch (err) {
      record('stream', { __cancel_error: true, message: (err as Error).message });
    }
  }, 5000);

  try {
    for await (const event of run.stream()) record('stream', event);
  } catch (err) {
    record('stream', { __stream_error: true, message: (err as Error).message });
  } finally {
    clearTimeout(cancelTimer);
  }
}

async function localErrored(): Promise<void> {
  try {
    const agent = await Agent.create({
      apiKey: apiKey!,
      name: 'fixture-local-errored',
      model: { id: 'this-model-does-not-exist-xyz' },
      local: { cwd: process.cwd() },
    } as any);
    const run = (await (agent as any).send('Hello.', {
      onDelta: ({ update }: any) => record('onDelta', update),
      onStep: ({ step }: any) => record('onStep', step),
    })) as any;
    run.onDidChangeStatus?.((status: any) => record('onDidChangeStatus', { status }));
    for await (const event of run.stream()) record('stream', event);
  } catch (err: any) {
    record('stream', {
      __caught_error: true,
      name: err?.name,
      message: err?.message,
      stack: err?.stack,
    });
  }
}

const scenarios: Record<string, () => Promise<void>> = {
  'local-quickstart': localQuickstart,
  'local-multiturn': localMultiturn,
  'local-cancelled': localCancelled,
  'local-errored': localErrored,
};

const fn = scenarios[scenario];
if (!fn) {
  console.error(`[capture] Unknown scenario: ${scenario}`);
  console.error(`[capture] Available: ${Object.keys(scenarios).join(', ')}`);
  process.exit(1);
}

console.log(`[capture] running scenario: ${scenario}`);
try {
  await fn();
} catch (err: any) {
  record('stream', {
    __top_level_error: true,
    name: err?.name,
    message: err?.message,
    stack: err?.stack,
  });
}
await flush(scenario);
