// src/instrumentation.ts
import { createRequire } from 'node:module';
import { registerInstrumentations, type Instrumentation } from '@opentelemetry/instrumentation';
import type { InitializeOptions } from './types';
import { wireOpenAIAgentsProcessor } from './openai-agents';
import { wireClaudeAgentSDKInstrumentation } from './claude-agent-sdk';
import { wirePiCodingAgentInstrumentation } from './pi';
import { instrumentPiAgentCore } from './pi-agent-core';
import { withAnthropicFallback } from './anthropic';

type InstrumentationWithManualPatch = Instrumentation & {
  manuallyInstrument(moduleRef: unknown): void;
};

type InstrumentationCtor = new () => InstrumentationWithManualPatch;

const OPENINFERENCE_PACKAGES = {
  openAI: ['@arizeai/openinference-instrumentation-openai', 'OpenAIInstrumentation'],
  anthropic: ['@arizeai/openinference-instrumentation-anthropic', 'AnthropicInstrumentation'],
  langchain: ['@arizeai/openinference-instrumentation-langchain', 'LangChainInstrumentation'],
  bedrock: ['@arizeai/openinference-instrumentation-bedrock', 'BedrockInstrumentation'],
  typeSafe: ['@arizeai/openinference-instrumentation-typesafe', 'TypeSafeInstrumentation'],
} as const;

// Provider keys (from OPENINFERENCE_PACKAGES) whose OpenInference instrumentation is actually
// registered. llmJudge reads this to avoid emitting its own LLM span when the provider call is
// already traced (which would nest an LLM span inside an LLM span).
const _instrumentedProviders = new Set<string>();

// TypeSafe emits decision spans, never LLM calls, so wiring it alone does not make an eval run's
// LLM usage readable.
const NOT_LLM_INTEGRATIONS = new Set(['typeSafe']);
const isLlmIntegration = (key: string): boolean => !NOT_LLM_INTEGRATIONS.has(key);

/** The LLM integrations one initialize() wired. */
export interface WiredIntegrations {
  /** How many were wired. */
  count: number;
  /** Whether one has patched a module yet. A module passed in `instrumentModules` is patched as it
   *  is wired; an auto-wired require hook patches only once it fires, which it never does for a
   *  module loaded as an ES module import. */
  patched(): boolean;
}

interface PatchableDefinition {
  patch?: (this: unknown, exports: unknown, version?: string) => unknown;
  files?: Array<{ patch: (this: unknown, exports: unknown, version?: string) => unknown }>;
}

/** Subclass an instrumentation so `onPatch` runs whenever one of its module hooks patches a
 *  module. Same seam as the Anthropic fallback: the definitions returned by init(). */
function withPatchSignal(Base: InstrumentationCtor, onPatch: () => void): InstrumentationCtor {
  const Initializing = Base as unknown as new () => InstrumentationWithManualPatch & {
    init(): unknown;
  };
  return class extends Initializing {
    init(): unknown {
      const definitions = super.init();
      const list = (Array.isArray(definitions) ? definitions : [definitions]) as Array<
        PatchableDefinition | undefined
      >;
      for (const definition of list) {
        const patch = definition?.patch;
        if (definition && patch) {
          definition.patch = function (exports, version) {
            onPatch();
            return patch.call(this, exports, version);
          };
        }
        for (const file of definition?.files ?? []) {
          const filePatch = file.patch;
          file.patch = function (exports, version) {
            onPatch();
            return filePatch.call(this, exports, version);
          };
        }
      }
      return definitions;
    }
  };
}

/** Whether the given provider key (e.g. 'anthropic', 'openAI') is currently instrumented. */
export function isProviderInstrumented(provider: string): boolean {
  return _instrumentedProviders.has(provider);
}

/** Test-only: seed the instrumented-provider set (mirrors what wireInstrumentations records). */
export function __setInstrumentedProvidersForTest(providers: string[]): void {
  _instrumentedProviders.clear();
  for (const p of providers) _instrumentedProviders.add(p);
}

// One static require per supported package. Keeping the module names literal (rather than
// passing them through require(pkg)) means bundlers and security scanners can see the full set,
// while the packages stay optional: each require only runs when its provider is wired.
// The SDK ships as plain CommonJS, so a consumer's bundler (esbuild, webpack, Rollup) that
// bundles node_modules reads this file. Anything passed to the `require` identifier gets
// resolved at build time: with the module names spelled out that means every
// instrumentation and its peers (for example @langchain/core) are pulled in, or fail to
// resolve, even though only the configured provider ever loads. A require obtained from
// createRequire is opaque to bundlers, so these stay runtime requires, while the names stay
// literal so static analysis can see the full set of loadable modules.
const requireOptional = createRequire(__filename);

const OPENINFERENCE_LOADERS: Record<string, () => Record<string, unknown>> = {
  '@arizeai/openinference-instrumentation-openai': () =>
    requireOptional('@arizeai/openinference-instrumentation-openai'),
  '@arizeai/openinference-instrumentation-anthropic': () =>
    requireOptional('@arizeai/openinference-instrumentation-anthropic'),
  '@arizeai/openinference-instrumentation-langchain': () =>
    requireOptional('@arizeai/openinference-instrumentation-langchain'),
  '@arizeai/openinference-instrumentation-bedrock': () =>
    requireOptional('@arizeai/openinference-instrumentation-bedrock'),
  '@arizeai/openinference-instrumentation-typesafe': () =>
    requireOptional('@arizeai/openinference-instrumentation-typesafe'),
};

function loadInstrumentation(pkg: string, exportName: string): InstrumentationCtor | null {
  const load = OPENINFERENCE_LOADERS[pkg];
  if (!load) return null;
  try {
    const mod = load();
    const ctor = mod[exportName];
    if (typeof ctor !== 'function') return null;
    return pkg === '@arizeai/openinference-instrumentation-anthropic'
      ? withAnthropicFallback(ctor as Parameters<typeof withAnthropicFallback>[0])
      : (ctor as InstrumentationCtor);
  } catch {
    return null;
  }
}

/**
 * Wires OpenInference instrumentations based on the instrumentModules option:
 *
 * - undefined  -> RITM auto-instrumentation for all supported modules (CJS only)
 * - {}         -> no instrumentation
 * - { openAI } -> manual patch only the provided module refs
 *
 * Called once by TraceRoot.initialize().
 *
 * All OpenInference instrumentations are lazy-loaded via require() so that
 * missing peer dependencies don't crash initialization.
 *
 * Returns the LLM integrations it wired.
 */
export function wireInstrumentations(
  instrumentModules: InitializeOptions['instrumentModules'],
): WiredIntegrations {
  if (instrumentModules === undefined) {
    // Auto-instrumentation via require-in-the-middle (CJS only).
    // ESM users must pass explicit module refs.
    const instrs: Instrumentation[] = [];
    let count = 0;
    let patched = false;
    const onPatch = (): void => {
      patched = true;
    };
    for (const [key, [pkg, exportName]] of Object.entries(OPENINFERENCE_PACKAGES)) {
      const Ctor = loadInstrumentation(pkg, exportName);
      if (Ctor) {
        instrs.push(new (isLlmIntegration(key) ? withPatchSignal(Ctor, onPatch) : Ctor)());
        if (isLlmIntegration(key)) count += 1;
        _instrumentedProviders.add(key);
      }
    }
    if (instrs.length > 0) {
      registerInstrumentations({ instrumentations: instrs });
    }
    return { count, patched: () => patched };
  }

  const instrs: Instrumentation[] = [];
  const keys: string[] = [];

  for (const [key, [pkg, exportName]] of Object.entries(OPENINFERENCE_PACKAGES)) {
    const moduleRef = instrumentModules[key as keyof typeof OPENINFERENCE_PACKAGES];
    if (!moduleRef) continue;
    const Ctor = loadInstrumentation(pkg, exportName);
    if (!Ctor) {
      throw new Error(`[traceroot] Failed to load ${pkg}. Install it: npm install ${pkg}`);
    }
    const instr = new Ctor();
    instrs.push(instr);
    instr.manuallyInstrument(moduleRef);
    keys.push(key);
    _instrumentedProviders.add(key);
  }

  let wired = keys.filter(isLlmIntegration).length;
  if (instrumentModules.claudeAgentSDK) {
    wireClaudeAgentSDKInstrumentation(instrumentModules.claudeAgentSDK);
    wired += 1;
  }
  if (instrumentModules.openaiAgents) {
    wireOpenAIAgentsProcessor(instrumentModules.openaiAgents);
    wired += 1;
  }
  if (instrumentModules.piCodingAgent) {
    wirePiCodingAgentInstrumentation(instrumentModules.piCodingAgent);
    wired += 1;
  }
  if (instrumentModules.piAgentCore) {
    instrumentPiAgentCore(instrumentModules.piAgentCore);
    wired += 1;
  }

  if (instrs.length > 0) {
    registerInstrumentations({ instrumentations: instrs });
  }
  // Each module was patched as it was wired above.
  return { count: wired, patched: () => wired > 0 };
}
