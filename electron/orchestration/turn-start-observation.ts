import { deliverPromptToPty, type PtyWriteFn } from '../agent/agent-prompt-delivery.js';
import type { AgentPaneActivitySnapshot, AgentStatusStore } from '../agent/agent-status-store.js';
import type { OrchestrationStartObservation } from './orchestration-types.js';

export interface TurnStartObservationOutcome {
  observation: OrchestrationStartObservation;
  reason?: string;
}

export interface DeliverAndObserveAgentTurnOptions {
  ptyId: string;
  prompt: string;
  submit?: boolean;
  settleDelayMs?: number;
  writePty: PtyWriteFn;
  agentStatusStore: AgentStatusStore;
  isPaneAlive?: (ptyId: string) => boolean;
  readScreen?: (ptyId: string) => string;
  getLastOutputAtMs?: (ptyId: string) => number;
  observeTimeoutMs?: number;
}

export type DeliverAndObserveAgentTurnResult =
  | {
      ok: true;
      bytesWritten: number;
      startObservation: OrchestrationStartObservation;
      observationReason?: string;
      promptDeferred?: boolean;
    }
  | {
      ok: false;
      error: string;
    };

const UNSUPPORTED_REASON = 'Target pane is unregistered in AgentStatusStore';
const QUEUED_REASON = 'Agent pane was already working; turn queued';
const PERMISSION_AFTER_WRITE_REASON = 'Agent entered permission/input wait state after prompt write';
const PERMISSION_WHILE_WORKING_REASON = 'Agent entered permission/input wait state';
const UNOBSERVED_REASON =
  'Prompt and Enter were written, but agent turn start was not observed within observation window; do not blindly resend.';

export function captureTurnActivityBaseline(
  store: AgentStatusStore,
  ptyId: string,
): AgentPaneActivitySnapshot | null {
  return store.getActivitySnapshot(ptyId);
}

export function evaluateTurnStartTransition(
  baseline: AgentPaneActivitySnapshot | null,
  current: AgentPaneActivitySnapshot | null,
): TurnStartObservationOutcome | null {
  if (!baseline && !current) {
    return {
      observation: 'unsupported',
      reason: UNSUPPORTED_REASON,
    };
  }

  if (!baseline?.exists || baseline.state !== 'working') {
    if (
      current?.state === 'working' ||
      (baseline && current && current.workingSequence > baseline.workingSequence)
    ) {
      return { observation: 'observed' };
    }
    if (
      current?.state === 'waiting' ||
      (baseline && current && current.permissionSequence > baseline.permissionSequence)
    ) {
      return {
        observation: 'permission',
        reason: PERMISSION_AFTER_WRITE_REASON,
      };
    }
    return null;
  }

  if (current && current.workingSequence > baseline.workingSequence) {
    return { observation: 'observed' };
  }
  if (current?.state === 'waiting') {
    return {
      observation: 'permission',
      reason: PERMISSION_WHILE_WORKING_REASON,
    };
  }
  return null;
}

type WaitResolution =
  | { kind: 'died' }
  | { kind: 'outcome'; outcome: TurnStartObservationOutcome };

async function waitForTurnStartObservation(opts: {
  ptyId: string;
  baseline: AgentPaneActivitySnapshot | null;
  agentStatusStore: AgentStatusStore;
  isPaneAlive?: (ptyId: string) => boolean;
  observeTimeoutMs: number;
}): Promise<WaitResolution> {
  let disposeActivity: () => void = () => {};
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  const cleanup = () => {
    const dispose = disposeActivity;
    disposeActivity = () => {};
    dispose();
    if (timeoutTimer !== undefined) {
      clearTimeout(timeoutTimer);
      timeoutTimer = undefined;
    }
    if (pollTimer !== undefined) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
  };

  try {
    return await new Promise<WaitResolution>((resolve) => {
      let settled = false;
      const settle = (resolution: WaitResolution) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(resolution);
      };

      const checkTransition = (snapshot?: AgentPaneActivitySnapshot | null) => {
        if (settled) return;
        if (opts.isPaneAlive && !opts.isPaneAlive(opts.ptyId)) {
          settle({ kind: 'died' });
          return;
        }
        const current =
          snapshot !== undefined
            ? snapshot
            : captureTurnActivityBaseline(opts.agentStatusStore, opts.ptyId);
        const outcome = evaluateTurnStartTransition(opts.baseline, current);
        if (outcome) {
          settle({ kind: 'outcome', outcome });
        }
      };

      disposeActivity = opts.agentStatusStore.onActivity((snapshot) => {
        if (snapshot.ptyId !== opts.ptyId) return;
        checkTransition(snapshot);
      });

      // Re-check immediately after registering the listener so synchronous/microtask edges are never missed.
      checkTransition();
      if (settled) return;

      if (opts.isPaneAlive) {
        const pollIntervalMs = Math.min(50, Math.max(10, Math.floor(opts.observeTimeoutMs / 4)));
        pollTimer = setInterval(() => {
          if (settled) return;
          if (!opts.isPaneAlive!(opts.ptyId)) {
            settle({ kind: 'died' });
          }
        }, pollIntervalMs);
      }

      timeoutTimer = setTimeout(() => {
        if (settled) return;
        checkTransition();
        if (settled) return;
        if (opts.baseline?.state === 'working') {
          settle({
            kind: 'outcome',
            outcome: {
              observation: 'queued',
              reason: QUEUED_REASON,
            },
          });
          return;
        }
        settle({
          kind: 'outcome',
          outcome: {
            observation: 'unobserved',
            reason: UNOBSERVED_REASON,
          },
        });
      }, opts.observeTimeoutMs);
    });
  } finally {
    cleanup();
  }
}

export async function deliverAndObserveAgentTurn(
  opts: DeliverAndObserveAgentTurnOptions,
): Promise<DeliverAndObserveAgentTurnResult> {
  const baseline = captureTurnActivityBaseline(opts.agentStatusStore, opts.ptyId);

  if (baseline?.state === 'waiting') {
    const reason =
      opts.agentStatusStore.get(opts.ptyId)?.message ??
      'Agent is waiting for confirmation before prompt delivery';
    return {
      ok: true,
      bytesWritten: 0,
      startObservation: 'permission',
      observationReason: reason,
      promptDeferred: true,
    };
  }

  let writeRes: { ok: true; bytesWritten: number } | { ok: false; error: string };
  try {
    const agentId = opts.agentStatusStore.get(opts.ptyId)?.agentId ?? null;
    writeRes = await deliverPromptToPty(
      {
        ptyId: opts.ptyId,
        prompt: opts.prompt,
        submit: opts.submit,
        settleDelayMs: opts.settleDelayMs,
        agentId,
        isPaneAlive: opts.isPaneAlive ? () => opts.isPaneAlive!(opts.ptyId) : undefined,
        readScreen: opts.readScreen ? () => opts.readScreen!(opts.ptyId) : undefined,
        getLastOutputAtMs: opts.getLastOutputAtMs ? () => opts.getLastOutputAtMs!(opts.ptyId) : undefined,
        hasTurnStartedOrBlocked: () =>
          evaluateTurnStartTransition(
            baseline,
            captureTurnActivityBaseline(opts.agentStatusStore, opts.ptyId),
          ) !== null,
      },
      opts.writePty,
    );
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (!writeRes.ok) {
    return { ok: false, error: writeRes.error };
  }

  if (opts.isPaneAlive && !opts.isPaneAlive(opts.ptyId)) {
    return { ok: false, error: 'Target pane exited during prompt delivery' };
  }

  const immediateOutcome = evaluateTurnStartTransition(
    baseline,
    captureTurnActivityBaseline(opts.agentStatusStore, opts.ptyId),
  );
  if (immediateOutcome) {
    return {
      ok: true,
      bytesWritten: writeRes.bytesWritten,
      startObservation: immediateOutcome.observation,
      ...(immediateOutcome.reason !== undefined
        ? { observationReason: immediateOutcome.reason }
        : {}),
    };
  }

  if (!opts.observeTimeoutMs || opts.observeTimeoutMs <= 0) {
    if (baseline?.state === 'working') {
      return {
        ok: true,
        bytesWritten: writeRes.bytesWritten,
        startObservation: 'queued',
        observationReason: QUEUED_REASON,
      };
    }
    if (!baseline) {
      return {
        ok: true,
        bytesWritten: writeRes.bytesWritten,
        startObservation: 'unsupported',
        observationReason: UNSUPPORTED_REASON,
      };
    }
    return {
      ok: true,
      bytesWritten: writeRes.bytesWritten,
      startObservation: 'pending',
    };
  }

  const waitRes = await waitForTurnStartObservation({
    ptyId: opts.ptyId,
    baseline,
    agentStatusStore: opts.agentStatusStore,
    isPaneAlive: opts.isPaneAlive,
    observeTimeoutMs: opts.observeTimeoutMs,
  });

  if (waitRes.kind === 'died') {
    return { ok: false, error: 'Target pane exited before turn start was observed' };
  }

  return {
    ok: true,
    bytesWritten: writeRes.bytesWritten,
    startObservation: waitRes.outcome.observation,
    ...(waitRes.outcome.reason !== undefined
      ? { observationReason: waitRes.outcome.reason }
      : {}),
  };
}
