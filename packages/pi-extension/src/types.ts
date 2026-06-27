// Minimal, self-contained view of the pi extension API surface this extension uses.
//
// These shapes are transcribed from the pi coding agent extension types
// (verified against the installed runtime, v0.79.x). Keeping a local copy means
// the package does not import pi internals at runtime; pi injects the live objects
// when it loads the extension. Only fields this extension reads are declared.

export type ExtensionMode = 'tui' | 'rpc' | 'json' | 'print';

export interface ContextUsage {
  /** Estimated context tokens, or null when unknown (e.g. just after compaction). */
  tokens: number | null;
  contextWindow: number;
  /** Usage as a fraction/percentage of the context window, or null when unknown. */
  percent: number | null;
}

export interface PiModel {
  provider?: string;
  id?: string;
}

export interface ReadonlySessionManager {
  getSessionFile?: () => string | undefined;
}

export interface ExtensionUI {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: string[] | undefined,
    options?: { placement?: 'aboveEditor' | 'belowEditor' },
  ): void;
  notify(message: string, type?: 'info' | 'warning' | 'error'): void;
}

export interface ExtensionContext {
  ui: ExtensionUI;
  mode: ExtensionMode;
  hasUI: boolean;
  cwd: string;
  model?: PiModel;
  sessionManager?: ReadonlySessionManager;
  isProjectTrusted?: () => boolean;
  getContextUsage?: () => ContextUsage | undefined;
  shutdown?: () => void;
}

export type CommandContext = ExtensionContext;

export interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number } | null;
}

export interface AgentMessageLike {
  role: string;
  usage?: UsageLike | null;
  stopReason?: string | null;
}

// Event payloads — only the fields this extension reads.
export interface SessionStartEvent {
  reason: 'startup' | 'reload' | 'new' | 'resume' | 'fork';
  previousSessionFile?: string;
}
export interface SessionShutdownEvent {
  reason: 'quit' | 'reload' | 'new' | 'resume' | 'fork';
}
export interface BeforeAgentStartEvent {
  prompt?: string;
}
export interface TurnStartEvent {
  turnIndex: number;
  timestamp?: number;
}
export interface TurnEndEvent {
  turnIndex: number;
}
export interface MessageEndEvent {
  message?: AgentMessageLike;
}
export interface ToolExecutionStartEvent {
  toolCallId: string;
  toolName: string;
  args: unknown;
}
export interface ToolExecutionEndEvent {
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
}
export interface ModelSelectEvent {
  model?: PiModel;
}
export interface ThinkingLevelSelectEvent {
  level?: string;
}
export interface BeforeProviderRequestEvent {
  payload: unknown;
}
export interface AfterProviderResponseEvent {
  status: number;
  headers?: Record<string, string>;
}
export interface SessionCompactEvent {
  compactionEntry?: { tokensBefore?: number };
}
export interface InputEvent {
  text?: string;
  source?: string;
  streamingBehavior?: string;
  images?: unknown[];
}

export type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

export interface CommandOptions {
  description?: string;
  handler: (args: string, ctx: CommandContext) => Promise<void> | void;
}

export interface ExtensionAPI {
  on(event: string, handler: EventHandler): void;
  registerCommand?: (name: string, options: CommandOptions) => void;
}
