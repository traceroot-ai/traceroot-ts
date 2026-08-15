// src/index.ts
import { TraceRoot } from './traceroot';
export { TraceRoot };
/** Top-level convenience alias for TraceRoot.initialize(...). */
export const initialize = TraceRoot.initialize.bind(TraceRoot);
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
export type {
  SpanType,
  ObserveOptions,
  InitializeOptions,
  PiCodingAgentInstrumentation,
} from './types';
export type { UsingAttributesOptions } from './usingAttributes';
export { OpenAIAgentsProcessor } from './openai-agents';
export { startSpan, usingSpan } from './spans';
export type { Span } from './spans';
export type { StartSpanOptions, SpanUpdate, TokenUsage } from './types';
export type { PiInstrumentationConfig } from './pi';

// Offline evaluation (local-first, trace-native) — full surface (parity with traceroot-py).
export {
  Dataset,
  DeferredScore,
  Evaluation,
  evaluate,
  evaluateAsync,
  pullDataset,
  pullDatasetVersion,
  PlatformTransport,
  FakeTransport,
  EvalRunResult,
  aggregateScores,
  caseStatus,
  scorer,
  llmJudge,
  Scorer,
  describeScorers,
  collectRunProvenance,
  DatasetConflictError,
  DatasetPublishAborted,
  EvalCompletionError,
  LocalDatasetSync,
  FakeDatasetSync,
  PlatformDatasetSync,
  newRunId,
  newDatasetId,
} from './eval';
export type {
  EvalCase,
  Score,
  ScorerContext,
  EvalItemResult,
  RunDatasetRef,
  ScoreSummary,
  UploadState,
  EvaluateOptions,
  EvaluationOptions,
  TaskFn,
  ScorerFn,
  ScoreLike,
  EvalTransport,
  PushResult,
  DatasetSyncTransport,
  ScorerDescriptor,
  DatasetSnapshot,
} from './eval';
