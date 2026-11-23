import type { WorkerTimelineEvent } from './worker-timeline.js';

export type AgentProvider = 'codex' | 'claude' | 'acp';

/**
 * How much the agent may do on its own. `read-only` cannot change files; `workspace-write` may edit
 * inside the workspace and asks before leaving it; `full-auto` stays in the same sandbox but never
 * stops to ask. None of them lifts the sandbox.
 */
export type AgentSessionPolicy = 'read-only' | 'workspace-write' | 'full-auto';

/**
 * Outcome of handing a prompt to the provider. `not_accepted` means the provider never took it, so
 * the caller may deliver it another way; `unknown_acceptance` means it may be running and must not
 * be sent again.
 */
export type TurnDelivery =
  | { status: 'accepted' }
  | { status: 'not_accepted' | 'unknown_acceptance'; reason: string };

/** Structured input sent with a message: a skill to invoke, or an image file on disk. */
export type AgentTurnAttachment =
  | { type: 'skill'; name: string; path: string }
  | { type: 'localImage'; path: string; name?: string };

export interface AgentTurnResult {
  turnId: string;
  stopReason: string;
  finalText: string;
  diff: string | null;
  usage: Record<string, number> | null;
  error: string | null;
}

/** Something the agent cannot proceed without: permission for an action, or an answer. */
export interface AgentRuntimeRequest {
  kind: 'approval' | 'question';
  method: string;
  toolInput: string;
  message?: string;
  questions?: AgentQuestion[];
  /** Aborts when the session ends, so a held request stops waiting. */
  signal: AbortSignal;
}

export interface AgentQuestion {
  id: string;
  header: string;
  prompt: string;
  /** The answer may be free text instead of one of the options. */
  allowOther: boolean;
  options: { label: string; description: string }[];
}

export type AgentRuntimeResponse =
  | { decision: 'accept' | 'decline' }
  | { answers: Record<string, string[]> };

/**
 * Callbacks are keyed by the `turnKey` the caller passed to `startTurn`. A completed turn only says
 * the provider stopped; whether the work is accepted is the caller's decision.
 */
export interface AgentSessionEvents {
  onTurnStarted: (turnKey: string) => void;
  onTurnCompleted: (turnKey: string, result: AgentTurnResult) => void;
  onRequest: (turnKey: string, request: AgentRuntimeRequest) => Promise<AgentRuntimeResponse>;
  /** Normalized process events for the active turn; text is already redacted by the driver. */
  onTimeline?: (turnKey: string, event: WorkerTimelineEvent) => void;
  onExit: (reason: string, exitCode: number | null) => void;
}

export interface AgentOutputSlice {
  screen: boolean;
  text: string;
  cursor: number;
  nextCursor: number;
  truncated: boolean;
  hasMore: boolean;
  alive: boolean;
  exitCode: number | null;
}

/** One provider conversation, driven over its native protocol instead of a terminal. */
export interface AgentSessionDriver {
  readonly provider: AgentProvider;
  readonly capabilities: { resume: boolean; steer: boolean; policies: readonly AgentSessionPolicy[] };
  readonly alive: boolean;
  readonly busy: boolean;
  readonly closing: boolean;
  /** The provider's own conversation id, once `open` resolved. */
  readonly sessionId: string | null;
  /** Model and reasoning effort the provider reported for the conversation, once `open` resolved. */
  readonly effectiveModel?: string | null;
  readonly effectiveEffort?: string | null;
  readonly latestTurnKey: string | null;

  /** Starts a conversation, or continues `resumeSessionId` where the provider left it. */
  /** `network` lets sandboxed commands reach the network; off unless asked for. */
  /** `developerInstructions` are set on the conversation, e.g. the Coordinator rules in orchestration mode. */
  open(input: {
    cwd: string; model: string | null; policy: AgentSessionPolicy; resumeSessionId?: string; network?: boolean;
    developerInstructions?: string;
  }): Promise<string>;
  /** `model`, `effort`, `policy`, and `network` apply to this turn and stay in effect for later ones. */
  startTurn(input: {
    turnKey: string; prompt: string; effort?: string | null; model?: string | null; policy?: AgentSessionPolicy;
    network?: boolean; attachments?: readonly AgentTurnAttachment[];
  }): Promise<TurnDelivery>;
  /** Asks the provider to stop the running turn; the turn then completes as interrupted. */
  interrupt(): Promise<boolean>;
  waitForIdle(timeoutMs: number): Promise<boolean>;
  read(turnKey: string, cursor?: number, limit?: number, screen?: boolean): AgentOutputSlice | null;
  redactText(text: string): string;
  close(interrupt?: boolean): Promise<void>;
}
