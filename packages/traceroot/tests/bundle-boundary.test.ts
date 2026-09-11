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
      metafile: true,
      logLevel: 'silent',
    });
    // metafile.inputs lists every module esbuild inlined into the bundle.
    const inlined = Object.keys(result.metafile.inputs);

    // Positive control: a statically imported dependency is inlined, so the bundle really
    // does include node_modules and the assertions below are meaningful.
    assert.ok(
      inlined.some((file) => file.includes('openinference-semantic-conventions')),
      'expected the statically imported semantic-conventions package to be bundled',
    );

    for (const provider of ['openai', 'anthropic', 'langchain', 'bedrock']) {
      assert.ok(
        !inlined.some((file) => file.includes(`openinference-instrumentation-${provider}`)),
        `${provider} instrumentation was bundled`,
      );
    }
    assert.ok(
      !inlined.some((file) => file.includes('client-bedrock-runtime')),
      'the Bedrock client (a peer of an optional instrumentation) was bundled',
    );
  });
});
