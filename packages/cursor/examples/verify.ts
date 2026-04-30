import dotenv from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from '@cursor/sdk';
import { initialize, flush, shutdown, wrapAgent } from '@traceroot-ai/cursor';

const __dirname = dirname(fileURLToPath(import.meta.url));
// ENV_PATH: dotenv reads .env from process.cwd() by default

dotenv.config();

const cursorApiKey = process.env.CURSOR_API_KEY;
const tracerootApiKey = process.env.TRACEROOT_API_KEY;
const baseUrl = process.env.TRACEROOT_BASE_URL ?? 'http://localhost:8000';

if (!cursorApiKey) {
  console.error(
    `[verify] CURSOR_API_KEY not found. Expected CURSOR_API_KEY/TRACEROOT_API_KEY in environment or .env at cwd`,
  );
  process.exit(1);
}
if (!tracerootApiKey) {
  console.error(
    `[verify] TRACEROOT_API_KEY not found. Expected CURSOR_API_KEY/TRACEROOT_API_KEY in environment or .env at cwd`,
  );
  console.error(`[verify] Get one from http://localhost:3000 -> Settings -> API Keys`);
  process.exit(1);
}

const sessionId = `verify-${Date.now()}`;
const userId = 'verify-user';

console.log(`[verify] initializing private TraceRoot tracer -> ${baseUrl}`);
initialize({
  apiKey: tracerootApiKey,
  baseUrl,
});

try {
  console.log(`[verify] creating Cursor agent`);
  const rawAgent = await Agent.create({
    apiKey: cursorApiKey,
    name: 'traceroot-verify',
    model: { id: process.env.CURSOR_MODEL ?? 'composer-2' },
    local: { cwd: process.cwd() },
  });

  console.log(`[verify] wrapping agent (sessionId=${sessionId}, userId=${userId})`);
  const agent = wrapAgent(rawAgent, { sessionId, userId });

  const prompt =
    'List the 3 files in this directory and explain what they do in one short sentence.';
  console.log(`[verify] sending prompt: ${prompt}`);
  const run = await agent.send(prompt);

  console.log(`[verify] streaming events from run.stream()...\n`);
  process.stdout.write('--- assistant output ---\n');
  for await (const event of run.stream()) {
    if (event.type === 'assistant') {
      for (const block of event.message.content) {
        if (block.type === 'text') process.stdout.write(block.text);
      }
    }
  }
  process.stdout.write('\n--- end assistant output ---\n');

  console.log(`[verify] awaiting run.wait()...`);
  const result = await run.wait();
  console.log(`[verify] run.wait result:`, JSON.stringify(result, null, 2));
} finally {
  console.log(`[verify] flushing spans to TraceRoot...`);
  await flush();

  console.log(`[verify] shutting down tracer...`);
  await shutdown();
}

console.log(`\n[verify] DONE.`);
console.log(`[verify] Open http://localhost:3000 and look for a trace with:`);
console.log(`           - service: traceroot-verify (or wrapper-attributed)`);
console.log(`           - cursor.session_id = "${sessionId}"`);
console.log(`           - root span: cursor.run`);
console.log(`           - children: cursor.tool.* per tool call`);
