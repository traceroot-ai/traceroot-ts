// src/instrumentation.ts
import { registerInstrumentations, type Instrumentation } from '@opentelemetry/instrumentation';
import type { InitializeOptions } from './types';
import { wireOpenAIAgentsProcessor } from './openai-agents';

type ManualInstrumentation = Instrumentation & {
  manuallyInstrument(moduleRef: unknown): void;
};

type ManualInstrumentationConstructor = new () => ManualInstrumentation;

function loadInstrumentation(
  packageName: string,
  exportName: string,
): ManualInstrumentationConstructor {
  const mod = module.require(packageName) as Record<string, unknown>;
  const ctor = mod[exportName];
  if (typeof ctor !== 'function') {
    throw new Error(`[TraceRoot] ${packageName} does not export ${exportName}`);
  }
  return ctor as ManualInstrumentationConstructor;
}

const loadOpenAIInstrumentation = () =>
  loadInstrumentation('@arizeai/openinference-instrumentation-openai', 'OpenAIInstrumentation');

const loadAnthropicInstrumentation = () =>
  loadInstrumentation(
    '@arizeai/openinference-instrumentation-anthropic',
    'AnthropicInstrumentation',
  );

const loadLangChainInstrumentation = () =>
  loadInstrumentation(
    '@arizeai/openinference-instrumentation-langchain',
    'LangChainInstrumentation',
  );

const loadClaudeAgentSDKInstrumentation = () =>
  loadInstrumentation(
    '@arizeai/openinference-instrumentation-claude-agent-sdk',
    'ClaudeAgentSDKInstrumentation',
  );

const loadBedrockInstrumentation = () =>
  loadInstrumentation('@arizeai/openinference-instrumentation-bedrock', 'BedrockInstrumentation');

/**
 * Wires OpenInference instrumentations based on the instrumentModules option:
 *
 * - undefined  → RITM auto-instrumentation for all supported modules (CJS only)
 * - {}         → no instrumentation
 * - { openAI } → manual patch only the provided module refs
 *
 * Called once by TraceRoot.initialize().
 */
export function wireInstrumentations(
  instrumentModules: InitializeOptions['instrumentModules'],
): void {
  if (instrumentModules === undefined) {
    // Auto-instrumentation via require-in-the-middle (CJS only).
    // ESM users must pass explicit module refs.
    registerInstrumentations({
      instrumentations: [
        new (loadOpenAIInstrumentation())(),
        new (loadAnthropicInstrumentation())(),
        new (loadLangChainInstrumentation())(),
        new (loadClaudeAgentSDKInstrumentation())(),
        new (loadBedrockInstrumentation())(),
      ],
    });
    return;
  }

  const instrs: Instrumentation[] = [];

  if (instrumentModules.openAI) {
    const instr = new (loadOpenAIInstrumentation())();
    instrs.push(instr);
    instr.manuallyInstrument(instrumentModules.openAI);
  }
  if (instrumentModules.anthropic) {
    const instr = new (loadAnthropicInstrumentation())();
    instrs.push(instr);
    instr.manuallyInstrument(instrumentModules.anthropic);
  }
  if (instrumentModules.langchain) {
    // langchain must be: import * as lcCallbackManager from '@langchain/core/callbacks/manager'
    const instr = new (loadLangChainInstrumentation())();
    instrs.push(instr);
    instr.manuallyInstrument(instrumentModules.langchain);
  }
  if (instrumentModules.claudeAgentSDK) {
    const instr = new (loadClaudeAgentSDKInstrumentation())();
    instrs.push(instr);
    instr.manuallyInstrument(instrumentModules.claudeAgentSDK);
  }
  if (instrumentModules.bedrock) {
    const instr = new (loadBedrockInstrumentation())();
    instrs.push(instr);
    instr.manuallyInstrument(instrumentModules.bedrock);
  }
  if (instrumentModules.openaiAgents) {
    wireOpenAIAgentsProcessor(instrumentModules.openaiAgents);
  }

  if (instrs.length > 0) {
    registerInstrumentations({ instrumentations: instrs });
  }
}
