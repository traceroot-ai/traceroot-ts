// src/eval/index.ts — public surface of the offline-evaluation module.

export { Dataset, DeferredScore, contentRevision } from './types';
export type { EvalCase, Score, ScorerContext, DatasetSnapshot } from './types';
export { ulid, newId, newDatasetId, newTestCaseId, newRunId } from './ids';
export {
  EvalRunResult,
  MainScore,
  MainScoreError,
  aggregateScores,
  caseStatus,
  makeRunResult,
  resolveMainScoreName,
  resolveMainScorePolicy,
} from './results';
export type { EvalItemResult, UploadState, ScoreSummary, RunDatasetRef, RunView } from './results';
export { evaluate, evaluateAsync } from './engine';
export type { EvaluateOptions, TaskFn, ScorerFn, ScoreLike, RunScorerFn } from './engine';
export { Evaluation } from './evaluation';
export type { EvaluationOptions } from './evaluation';
export { FakeTransport } from './transport';
export type { EvalTransport, RunHandle, PublishResult } from './transport';
export { pullDataset, pullDatasetVersion, PlatformTransport } from './platform';
export type {
  PullOptions,
  PullVersionOptions,
  PlatformTransportOptions,
  ScorerSpec,
} from './platform';
export {
  DatasetConflictError,
  LocalDatasetSync,
  FakeDatasetSync,
  PlatformDatasetSync,
} from './dataset_sync';
export type { PushResult, DatasetSyncTransport } from './dataset_sync';
export {
  scorer,
  llmJudge,
  describeScorers,
  scorerMetadata,
  declaredVersion,
  validateRequiredInputs,
  VALUE_TYPES,
  DIRECTIONS,
  REQUIRED_INPUTS,
} from './scorers';
export type {
  Scorer,
  ScorerMeta,
  ScorerDescriptor,
  ValueType,
  Direction,
  RequiredInput,
} from './scorers';
export { collectRunProvenance, gitDirty, runProvenance } from './provenance';
export {
  datasetLatestSnippet,
  datasetVersionSnippet,
  reproduceRunSnippet,
  LANGUAGES,
} from './snippets';
export type { SnippetLang } from './snippets';
export {
  EVAL_API_VERSION,
  capabilities,
  discover,
  runSuite,
  writeArtifacts,
  Emitter,
} from './runner';
