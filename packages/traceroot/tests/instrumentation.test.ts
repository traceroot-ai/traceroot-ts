import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function runScript(script: string) {
  const pkgDir = process.cwd();
  const tsxLoader = pathToFileURL(
    path.join(pkgDir, 'node_modules', 'tsx', 'dist', 'loader.mjs'),
  ).href;
  return spawnSync(process.execPath, ['--import', tsxLoader, '-e', script], {
    cwd: pkgDir,
    encoding: 'utf8',
  });
}

describe('wireInstrumentations() lazy loading', () => {
  it('does not load OpenAI package when only Anthropic is requested', () => {
    const result = runScript(`
      const Module = require('node:module');
      const orig = Module._load;
      Module._load = function(request, ...rest) {
        if (request === '@arizeai/openinference-instrumentation-openai')
          throw new Error('should not load openai instrumentation');
        if (request === '@arizeai/openinference-instrumentation-anthropic')
          return { AnthropicInstrumentation: class { manuallyInstrument() {} } };
        if (request === '@arizeai/openinference-instrumentation-langchain')
          throw new Error('should not load langchain instrumentation');
        if (request === '@arizeai/openinference-instrumentation-bedrock')
          throw new Error('should not load bedrock instrumentation');
        return orig.apply(this, [request, ...rest]);
      };
      const { wireInstrumentations } = require('./src/instrumentation.ts');
      wireInstrumentations({ anthropic: { name: 'mock' } });
      console.log('OK');
    `);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(result.stdout.includes('OK'));
  });

  it('auto-instrumentation path skips missing packages gracefully', () => {
    const result = runScript(`
      const Module = require('node:module');
      const orig = Module._load;
      const loaded = [];
      Module._load = function(request, ...rest) {
        if (request.startsWith('@arizeai/openinference-instrumentation-')) {
          throw new Error('MODULE_NOT_FOUND');
        }
        return orig.apply(this, [request, ...rest]);
      };
      const { wireInstrumentations } = require('./src/instrumentation.ts');
      wireInstrumentations(undefined);
      console.log('OK');
    `);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(result.stdout.includes('OK'));
  });

  it('explicit-modules path throws when a requested package is missing', () => {
    const result = runScript(`
      const Module = require('node:module');
      const orig = Module._load;
      Module._load = function(request, ...rest) {
        if (request === '@arizeai/openinference-instrumentation-openai')
          throw new Error('MODULE_NOT_FOUND');
        return orig.apply(this, [request, ...rest]);
      };
      const { wireInstrumentations } = require('./src/instrumentation.ts');
      try {
        wireInstrumentations({ openAI: { name: 'mock' } });
        console.log('SHOULD_HAVE_THROWN');
      } catch (e) {
        console.log('THREW:' + e.message);
      }
    `);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(result.stdout.includes('THREW:'));
    assert.ok(result.stdout.includes('Failed to load'));
  });

  it('claudeAgentSDK path does not go through OpenInference loader', () => {
    const result = runScript(`
      const Module = require('node:module');
      const orig = Module._load;
      Module._load = function(request, ...rest) {
        if (request.startsWith('@arizeai/openinference-instrumentation-'))
          throw new Error('should not load any openinference package');
        return orig.apply(this, [request, ...rest]);
      };
      const { wireInstrumentations } = require('./src/instrumentation.ts');
      wireInstrumentations({ claudeAgentSDK: { query: function() {} } });
      console.log('OK');
    `);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(result.stdout.includes('OK'));
  });
});
