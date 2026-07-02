// src/index.ts
export { TraceRoot } from './traceroot';
export { observe } from './observe';
export {
  updateCurrentSpan,
  updateCurrentTrace,
  getCurrentTraceId,
  getCurrentSpanId,
} from './context';
export { usingAttributes } from './usingAttributes';
export { SpanAttributes } from './constants';
export type { SpanType, SpanUsage, ObserveOptions, InitializeOptions } from './types';
export type { UsingAttributesOptions } from './usingAttributes';
export { OpenAIAgentsProcessor } from './openai-agents';
