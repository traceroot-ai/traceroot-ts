// src/instrumentation.ts
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { AnthropicInstrumentation } from '@arizeai/openinference-instrumentation-anthropic';
import { BedrockInstrumentation } from '@arizeai/openinference-instrumentation-bedrock';
import { LangChainInstrumentation } from '@arizeai/openinference-instrumentation-langchain';
import { OpenAIInstrumentation } from '@arizeai/openinference-instrumentation-openai';
import { InitializeOptions } from './types';
import { wireOpenAIAgentsProcessor } from './openai-agents';
import { wireClaudeAgentSDKInstrumentation } from './claude-agent-sdk';

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
        new OpenAIInstrumentation(),
        new AnthropicInstrumentation(),
        new LangChainInstrumentation(),
        new BedrockInstrumentation(),
      ],
    });
    return;
  }

  const instrs: InstanceType<
    | typeof OpenAIInstrumentation
    | typeof AnthropicInstrumentation
    | typeof LangChainInstrumentation
    | typeof BedrockInstrumentation
  >[] = [];

  if (instrumentModules.openAI) {
    const instr = new OpenAIInstrumentation();
    instrs.push(instr);
    instr.manuallyInstrument(instrumentModules.openAI as any);
  }
  if (instrumentModules.anthropic) {
    const instr = new AnthropicInstrumentation();
    instrs.push(instr);
    instr.manuallyInstrument(instrumentModules.anthropic as any);
  }
  if (instrumentModules.langchain) {
    // langchain must be: import * as lcCallbackManager from '@langchain/core/callbacks/manager'
    const instr = new LangChainInstrumentation();
    instrs.push(instr);
    instr.manuallyInstrument(instrumentModules.langchain as any);
  }
  if (instrumentModules.claudeAgentSDK) {
    // Claude Agent SDK uses TraceRoot's in-house wrapper for stable agent/tool/LLM structure.
    // Auto RITM is intentionally not enabled for it until this wrapper has its own loader hook.
    wireClaudeAgentSDKInstrumentation(instrumentModules.claudeAgentSDK);
  }
  if (instrumentModules.bedrock) {
    const instr = new BedrockInstrumentation();
    instrs.push(instr);
    instr.manuallyInstrument(instrumentModules.bedrock as any);
  }
  if (instrumentModules.openaiAgents) {
    wireOpenAIAgentsProcessor(instrumentModules.openaiAgents);
  }

  if (instrs.length > 0) {
    registerInstrumentations({ instrumentations: instrs });
  }
}
