import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { build } from 'esbuild';

// The SDK is published unbundled. When a consumer bundles their app with node_modules
// included, the optional OpenInference instrumentations must stay runtime requires: the
// bundler must neither inline them nor chase their peers (@langchain/core, the Bedrock
// client), because a consumer who uses one provider does not have the others' peers.
describe('consumer bundling boundary', () => {
  it('leaves the optional instrumentations out of a consumer bundle', async () => {
    const result = await build({
      entryPoints: [path.join(process.cwd(), 'src', 'index.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      write: false,
      logLevel: 'silent',
    });
    const text = result.outputFiles[0].text;
    for (const provider of ['openai', 'anthropic', 'langchain', 'bedrock']) {
      // esbuild labels every inlined module with a "// <path>" header comment.
      const inlined = new RegExp(`^// .*openinference-instrumentation-${provider}`, 'm');
      assert.equal(inlined.test(text), false, `${provider} instrumentation was bundled`);
    }
    assert.equal(text.includes('@aws-sdk/client-bedrock-runtime'), false);
  });
});
