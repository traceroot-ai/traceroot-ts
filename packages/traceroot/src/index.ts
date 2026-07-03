// src/index.ts
export { TraceRoot } from './traceroot';
export { observe } from './observe';
export {
  updateCurrentSpan,
  updateCurrentTrace,
  getCurrentTraceId,
  getCurrentSpanId,
  getCurrentSpan,
} from './context';
export { usingAttributes } from './usingAttributes';
export { SpanAttributes } from './constants';
export type { SpanType, ObserveOptions, InitializeOptions } from './types';
export type { UsingAttributesOptions } from './usingAttributes';
export { OpenAIAgentsProcessor } from './openai-agents';
export { startSpan, usingSpan } from './spans';
export type { Span } from './spans';
export type { StartSpanOptions, SpanUpdate, TokenUsage } from './types';
