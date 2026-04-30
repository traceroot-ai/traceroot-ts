import dotenv from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from '@cursor/sdk';
import { initialize, flush, shutdown, wrapAgent } from '@traceroot-ai/cursor';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: undefined /* env read from cwd by default */ });

const cursorApiKey = process.env.CURSOR_API_KEY;
const tracerootApiKey = process.env.TRACEROOT_API_KEY;
const baseUrl = process.env.TRACEROOT_BASE_URL ?? 'http://localhost:8000';

if (!cursorApiKey || !tracerootApiKey) {
  console.error('[examples] Missing CURSOR_API_KEY or TRACEROOT_API_KEY');
  process.exit(1);
}

initialize({ apiKey: tracerootApiKey, baseUrl });

async function runScenario(label: string, prompts: string[]): Promise<void> {
  const sessionId = `${label}-${Date.now()}`;
  console.log(`\n========== ${label} (sessionId=${sessionId}) ==========`);

  const rawAgent = await Agent.create({
    apiKey: cursorApiKey!,
    name: `examples-${label}`,
    model: { id: 'composer-2' },
    local: { cwd: process.cwd() },
  });

  const agent = wrapAgent(rawAgent, { sessionId, userId: 'examples-user' });

  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i]!;
    console.log(
      `\n--- Turn ${i + 1}/${prompts.length}: ${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}`,
    );
    const run = await agent.send(prompt);
    let outputLen = 0;
    for await (const event of run.stream()) {
      if (event.type === 'assistant') {
        for (const block of event.message.content) {
          if (block.type === 'text') {
            outputLen += block.text.length;
          }
        }
      }
    }
    const result = await run.wait();
    console.log(
      `    [run ${i + 1} ${result.status}, output ~${outputLen} chars, run_id=${result.id}]`,
    );
  }
}

try {
  await runScenario('multiturn', [
    "What's the most prominent language by file count in this folder?",
    'Now show me the smallest non-empty TypeScript file in this folder and explain its purpose in one sentence.',
  ]);

  await runScenario('explore', [
    "Find every file under this folder that mentions 'TraceRoot' (case-insensitive) and summarize what each does in one short bullet. Use glob, grep, and read tools.",
  ]);

  await runScenario('reasoning', [
    'If I wanted to add real-time streaming of shell tool output to my OTel traces (so each shell line becomes a span event), describe the minimal change to make in a TypeScript wrapper. Plan only — no code. Use read tool to look at any local file you find that might be relevant.',
  ]);
} finally {
  console.log('\n[examples] flushing spans + shutting down...');
  await flush();
  await shutdown();
  console.log(
    '[examples] DONE. Open http://localhost:3000 cursor-sdk project, sort by recent traces.',
  );
}
