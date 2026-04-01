// src/index.ts
export { TraceRoot } from './traceroot';
export { observe } from './observe';
export { updateCurrentSpan, updateCurrentTrace, getCurrentTraceId, getCurrentSpanId } from './context';
export { usingAttributes } from './usingAttributes';
export type { SpanType, ObserveOptions, InitializeOptions } from './types';
export type { UsingAttributesOptions } from './usingAttributes';
