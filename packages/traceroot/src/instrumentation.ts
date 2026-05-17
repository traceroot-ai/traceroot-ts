// src/instrumentation.ts
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { InitializeOptions } from './types';
import { wireOpenAIAgentsProcessor } from './openai-agents';

/**
 * Lazily loads a module export. Returns the constructor or null if the
 * module (or its peer dependencies) cannot be resolved. This prevents
 * TraceRoot.initialize() from crashing when a project doesn't depend on
 * every peer dep of every instrumentation package.
 *
 * @example
 *   const OpenAICtor = safeRequire(
 *     '@arizeai/openinference-instrumentation-openai',
 *     'OpenAIInstrumentation',
 *   );
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function safeRequire(pkg: string, exportName: string): any | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(pkg);
    return mod[exportName] || null;
  } catch {
    return null;
  }
}

/**
 * Wires OpenInference instrumentations based on the instrumentModules option:
 *
 * - undefined  → RITM auto-instrumentation for all supported modules (CJS only)
 * - {}         → no instrumentation
 * - { openAI } → manual patch only the provided module refs
 *
 * Called once by TraceRoot.initialize().
 *
 * All OpenInference instrumentations are lazy-loaded via require() so that
 * missing peer dependencies (e.g. `openai`, `@anthropic-ai/sdk`, `bedrock`)
 * don't crash initialization. An instrumentation is silently skipped when
 * its module can't be resolved.
 */
export function wireInstrumentations(
  instrumentModules: InitializeOptions['instrumentModules'],
): void {
  if (instrumentModules === undefined) {
    // Auto-instrumentation via require-in-the-middle (CJS only).
    // ESM users must pass explicit module refs.
    const instrs: any[] = [];

    const OpenAIInstrumentation = safeRequire(
      '@arizeai/openinference-instrumentation-openai',
      'OpenAIInstrumentation',
    );
    if (OpenAIInstrumentation) instrs.push(new OpenAIInstrumentation());

    const AnthropicInstrumentation = safeRequire(
      '@arizeai/openinference-instrumentation-anthropic',
      'AnthropicInstrumentation',
    );
    if (AnthropicInstrumentation) instrs.push(new AnthropicInstrumentation());

    const LangChainInstrumentation = safeRequire(
      '@arizeai/openinference-instrumentation-langchain',
      'LangChainInstrumentation',
    );
    if (LangChainInstrumentation) instrs.push(new LangChainInstrumentation());

    const ClaudeAgentSDKInstrumentation = safeRequire(
      '@arizeai/openinference-instrumentation-claude-agent-sdk',
      'ClaudeAgentSDKInstrumentation',
    );
    if (ClaudeAgentSDKInstrumentation)
      instrs.push(new ClaudeAgentSDKInstrumentation());

    const BedrockInstrumentation = safeRequire(
      '@arizeai/openinference-instrumentation-bedrock',
      'BedrockInstrumentation',
    );
    if (BedrockInstrumentation) instrs.push(new BedrockInstrumentation());

    if (instrs.length > 0) {
      registerInstrumentations({ instrumentations: instrs });
    }
    return;
  }

  const instrs: any[] = [];

  if (instrumentModules.openAI) {
    const OpenAIInstrumentation = safeRequire(
      '@arizeai/openinference-instrumentation-openai',
      'OpenAIInstrumentation',
    );
    if (OpenAIInstrumentation) {
      const instr = new OpenAIInstrumentation();
      instrs.push(instr);
      instr.manuallyInstrument(instrumentModules.openAI as any);
    }
  }
  if (instrumentModules.anthropic) {
    const AnthropicInstrumentation = safeRequire(
      '@arizeai/openinference-instrumentation-anthropic',
      'AnthropicInstrumentation',
    );
    if (AnthropicInstrumentation) {
      const instr = new AnthropicInstrumentation();
      instrs.push(instr);
      instr.manuallyInstrument(instrumentModules.anthropic as any);
    }
  }
  if (instrumentModules.langchain) {
    const LangChainInstrumentation = safeRequire(
      '@arizeai/openinference-instrumentation-langchain',
      'LangChainInstrumentation',
    );
    if (LangChainInstrumentation) {
      const instr = new LangChainInstrumentation();
      instrs.push(instr);
      instr.manuallyInstrument(instrumentModules.langchain as any);
    }
  }
  if (instrumentModules.claudeAgentSDK) {
    const ClaudeAgentSDKInstrumentation = safeRequire(
      '@arizeai/openinference-instrumentation-claude-agent-sdk',
      'ClaudeAgentSDKInstrumentation',
    );
    if (ClaudeAgentSDKInstrumentation) {
      const instr = new ClaudeAgentSDKInstrumentation();
      instrs.push(instr);
      instr.manuallyInstrument(instrumentModules.claudeAgentSDK as any);
    }
  }
  if (instrumentModules.bedrock) {
    const BedrockInstrumentation = safeRequire(
      '@arizeai/openinference-instrumentation-bedrock',
      'BedrockInstrumentation',
    );
    if (BedrockInstrumentation) {
      const instr = new BedrockInstrumentation();
      instrs.push(instr);
      instr.manuallyInstrument(instrumentModules.bedrock as any);
    }
  }
  if (instrumentModules.openaiAgents) {
    wireOpenAIAgentsProcessor(instrumentModules.openaiAgents);
  }

  if (instrs.length > 0) {
    registerInstrumentations({ instrumentations: instrs });
  }
}
