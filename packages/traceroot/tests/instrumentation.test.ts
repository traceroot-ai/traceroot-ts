import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

function runIsolatedInstrumentationScript(script: string) {
  const tsxLoader = pathToFileURL(
    path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'loader.mjs'),
  ).href;
  return spawnSync(process.execPath, ['--import', tsxLoader, '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

describe('wireInstrumentations()', () => {
  it('does not load OpenAI instrumentation when only Anthropic is requested', () => {
    const result = runIsolatedInstrumentationScript(`
      const Module = require('node:module');
      const originalLoad = Module._load;

      class FakeAnthropicInstrumentation {
        manuallyInstrument(moduleRef) {
          if (moduleRef.name !== 'anthropic-module') {
            throw new Error('unexpected module ref');
          }
        }
      }

      Module._load = function(request, parent, isMain) {
        if (request === '@opentelemetry/instrumentation') {
          return { registerInstrumentations: () => {} };
        }
        if (request === '@arizeai/openinference-instrumentation-anthropic') {
          return { AnthropicInstrumentation: FakeAnthropicInstrumentation };
        }
        if (request === '@arizeai/openinference-instrumentation-openai') {
          throw new Error('OpenAI instrumentation should not be loaded');
        }
        if (request.startsWith('@arizeai/openinference-instrumentation-')) {
          throw new Error(request + ' should not be loaded');
        }
        return originalLoad.apply(this, arguments);
      };

      const { wireInstrumentations } = require('./src/instrumentation.ts');
      wireInstrumentations({ anthropic: { name: 'anthropic-module' } });
    `);

    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
});
