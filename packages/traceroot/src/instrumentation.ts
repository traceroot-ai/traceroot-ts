// src/instrumentation.ts
import { registerInstrumentations, type Instrumentation } from '@opentelemetry/instrumentation';
import type { InitializeOptions } from './types';
import { wireOpenAIAgentsProcessor } from './openai-agents';
import { wireClaudeAgentSDKInstrumentation } from './claude-agent-sdk';

type InstrumentationWithManualPatch = Instrumentation & {
  manuallyInstrument(moduleRef: unknown): void;
};

type InstrumentationCtor = new () => InstrumentationWithManualPatch;

const OPENINFERENCE_PACKAGES = {
  openAI: ['@arizeai/openinference-instrumentation-openai', 'OpenAIInstrumentation'],
  anthropic: ['@arizeai/openinference-instrumentation-anthropic', 'AnthropicInstrumentation'],
  langchain: ['@arizeai/openinference-instrumentation-langchain', 'LangChainInstrumentation'],
  bedrock: ['@arizeai/openinference-instrumentation-bedrock', 'BedrockInstrumentation'],
} as const;

// Provider keys (from OPENINFERENCE_PACKAGES) whose OpenInference instrumentation is actually
// registered. llmJudge reads this to avoid emitting its own LLM span when the provider call is
// already traced (which would nest an LLM span inside an LLM span).
const _instrumentedProviders = new Set<string>();

/** Whether the given provider key (e.g. 'anthropic', 'openAI') is currently instrumented. */
export function isProviderInstrumented(provider: string): boolean {
  return _instrumentedProviders.has(provider);
}

/** Test-only: seed the instrumented-provider set (mirrors what wireInstrumentations records). */
export function __setInstrumentedProvidersForTest(providers: string[]): void {
  _instrumentedProviders.clear();
  for (const p of providers) _instrumentedProviders.add(p);
}

function loadInstrumentation(pkg: string, exportName: string): InstrumentationCtor | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(pkg) as Record<string, unknown>;
    const ctor = mod[exportName];
    if (typeof ctor !== 'function') return null;
    return ctor as InstrumentationCtor;
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
 */
export function wireInstrumentations(
  instrumentModules: InitializeOptions['instrumentModules'],
): void {
  if (instrumentModules === undefined) {
    // Auto-instrumentation via require-in-the-middle (CJS only).
    // ESM users must pass explicit module refs.
    const instrs: Instrumentation[] = [];
    for (const [key, [pkg, exportName]] of Object.entries(OPENINFERENCE_PACKAGES)) {
      const Ctor = loadInstrumentation(pkg, exportName);
      if (Ctor) {
        instrs.push(new Ctor());
        _instrumentedProviders.add(key);
      }
    }
    if (instrs.length > 0) {
      registerInstrumentations({ instrumentations: instrs });
    }
    return;
  }

  const instrs: Instrumentation[] = [];

  for (const [key, [pkg, exportName]] of Object.entries(OPENINFERENCE_PACKAGES)) {
    const moduleRef = instrumentModules[key as keyof typeof OPENINFERENCE_PACKAGES];
    if (!moduleRef) continue;
    const Ctor = loadInstrumentation(pkg, exportName);
    if (!Ctor) {
      throw new Error(`[TraceRoot] Failed to load ${pkg}. Install it: npm install ${pkg}`);
    }
    const instr = new Ctor();
    instrs.push(instr);
    instr.manuallyInstrument(moduleRef);
    _instrumentedProviders.add(key);
  }

  if (instrumentModules.claudeAgentSDK) {
    wireClaudeAgentSDKInstrumentation(instrumentModules.claudeAgentSDK);
  }
  if (instrumentModules.openaiAgents) {
    wireOpenAIAgentsProcessor(instrumentModules.openaiAgents);
  }

  if (instrs.length > 0) {
    registerInstrumentations({ instrumentations: instrs });
  }
}
