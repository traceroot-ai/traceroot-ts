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
export type { SpanType, ObserveOptions, InitializeOptions } from './types';
export type { UsingAttributesOptions } from './usingAttributes';
export { OpenAIAgentsProcessor } from './openai-agents';
export { startSpan, usingSpan } from './spans';
export type { Span } from './spans';
export type { StartSpanOptions, SpanUpdate, TokenUsage } from './types';

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
  LocalTransport,
  FakeTransport,
  RunSession,
  EvalRunResult,
  compareRuns,
  Comparison,
  aggregateScores,
  caseStatus,
  scorer,
  describeScorers,
  collectRunProvenance,
  datasetLatestSnippet,
  datasetVersionSnippet,
  reproduceRunSnippet,
  DatasetConflictError,
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
  RunView,
  ScoreSummary,
  UploadState,
  EvaluateOptions,
  EvaluationOptions,
  TaskFn,
  ScorerFn,
  ScoreLike,
  RunScorerFn,
  EvalTransport,
  PushResult,
  DatasetSyncTransport,
  Scorer,
  ScorerDescriptor,
  CaseDelta,
  DatasetSnapshot,
} from './eval';
