// src/instrumentation.ts
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { AnthropicInstrumentation } from '@arizeai/openinference-instrumentation-anthropic';
import { BedrockInstrumentation } from '@arizeai/openinference-instrumentation-bedrock';
import { ClaudeAgentSDKInstrumentation } from '@arizeai/openinference-instrumentation-claude-agent-sdk';
import { LangChainInstrumentation } from '@arizeai/openinference-instrumentation-langchain';
import { OpenAIInstrumentation } from '@arizeai/openinference-instrumentation-openai';
import { InitializeOptions } from './types';

type InstrumentModules = NonNullable<InitializeOptions['instrumentModules']>;

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
        new ClaudeAgentSDKInstrumentation(),
        new BedrockInstrumentation(),
      ],
    });
    return;
  }

  const instrs: InstanceType<
    | typeof OpenAIInstrumentation
    | typeof AnthropicInstrumentation
    | typeof LangChainInstrumentation
    | typeof ClaudeAgentSDKInstrumentation
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
    const instr = new ClaudeAgentSDKInstrumentation();
    instrs.push(instr);
    instr.manuallyInstrument(instrumentModules.claudeAgentSDK as any);
  }
  if (instrumentModules.bedrock) {
    const instr = new BedrockInstrumentation();
    instrs.push(instr);
    instr.manuallyInstrument(instrumentModules.bedrock as any);
  }

  if (instrs.length > 0) {
    registerInstrumentations({ instrumentations: instrs });
  }
}
