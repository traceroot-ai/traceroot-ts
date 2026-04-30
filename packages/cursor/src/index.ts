export { wrapAgent } from './wrap-agent.js';
export type { WrappedAgentOptions } from './wrap-agent.js';

export { initialize, flush, shutdown, getCursorTracer } from './initialize.js';
export type { InitializeOptions, CursorTracingHandle } from './initialize.js';

export type {
  AdapterOptions,
  MapperContext,
  Runtime,
  SpanOp,
  SpanTarget,
  TerminalStatus,
  ToolCloseStatus,
} from './types.js';
