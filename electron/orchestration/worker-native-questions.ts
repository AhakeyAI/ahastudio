import { randomUUID } from 'node:crypto';
import type { AgentQuestion, AgentRuntimeResponse } from './agent-session-driver.js';
import { ACTIVE_DISPATCH_STATUSES } from './orchestration-lifecycle-graph.js';
import type { OrchestrationStore } from './orchestration-store.js';
import {
  OrchestrationError,
  type OrchestrationDispatchRecord,
  type WorkerNativeQuestionPayload,
} from './orchestration-types.js';
import { redactDispatchCapability } from './worker-dispatch-preamble.js';

const DECLINE: AgentRuntimeResponse = { decision: 'decline' };

interface HeldNativeQuestionEntry {
  payload: WorkerNativeQuestionPayload;
  resolve: (response: AgentRuntimeResponse) => void;
  redact: (text: string) => string;
  timer: ReturnType<typeof setTimeout> | null;
  cleanupSignal?: () => void;
}

export interface WorkerNativeQuestionManagerDependencies {
  store: OrchestrationStore;
  hasOpenApprovalForDispatch: (dispatchId: string) => boolean;
  onChanged?: (reason: string, runId: string) => void;
  onAnswered?: (payload: WorkerNativeQuestionPayload, answers: Record<string, string[]>) => void;
  /** Optional safety timeout in ms; 0 (default) waits until answered, skipped, or the turn/session ends. */
  holdTimeoutMs?: number;
  now?: () => number;
}

export interface HoldNativeQuestionInput {
  /** The driver that asked; recorded so the UI never assumes Codex. */
  provider: string;
  method: string;
  questions: AgentQuestion[];
  signal: AbortSignal;
  /** The driver's own secret redaction (Aha MCP credentials), applied before dispatch credentials. */
  redact?: (text: string) => string;
}

function clonePayload(payload: WorkerNativeQuestionPayload): WorkerNativeQuestionPayload {
  return {
    ...payload,
    questions: payload.questions.map((question) => ({
      ...question,
      options: question.options.map((option) => ({ ...option })),
    })),
    answers: payload.answers
      ? Object.fromEntries(Object.entries(payload.answers).map(([key, values]) => [key, [...values]]))
      : payload.answers ?? null,
  };
}

const stripDispatchPrefix = (value: string): string =>
  value.startsWith('dispatch:') ? value.slice('dispatch:'.length) : value;

/**
 * Holds structured questions a headless Worker's agent asks over its native protocol (Codex
 * `requestUserInput`, Claude `AskUserQuestion`, ACP form elicitation, Grok `ask_user_question`)
 * until the person answers or skips them, or the Worker's turn or process ends.
 */
export class WorkerNativeQuestionManager {
  private readonly openByRequestId = new Map<string, HeldNativeQuestionEntry>();
  private readonly historyByRequestId = new Map<string, WorkerNativeQuestionPayload>();
  private readonly holdTimeoutMs: number;
  private readonly clock: () => number;

  constructor(private readonly deps: WorkerNativeQuestionManagerDependencies) {
    const rawTimeout = deps.holdTimeoutMs ?? 0;
    this.holdTimeoutMs = rawTimeout > 0 ? Math.max(500, Math.floor(rawTimeout)) : 0;
    this.clock = deps.now ?? (() => Date.now());
  }

  hasOpenQuestionForDispatch(dispatchId: string): boolean {
    for (const entry of this.openByRequestId.values()) {
      if (entry.payload.dispatchId === dispatchId) return true;
    }
    return false;
  }

  listOpenQuestions(filter?: { runId?: string; dispatchId?: string; workerHandle?: string }): WorkerNativeQuestionPayload[] {
    return [...this.openByRequestId.values()]
      .map((entry) => clonePayload(entry.payload))
      .filter((question) =>
        (!filter?.runId || question.runId === filter.runId) &&
        (!filter?.dispatchId || question.dispatchId === filter.dispatchId) &&
        (!filter?.workerHandle || question.workerHandle === filter.workerHandle))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getQuestion(requestId: string): WorkerNativeQuestionPayload | undefined {
    const payload = this.openByRequestId.get(requestId)?.payload ?? this.historyByRequestId.get(requestId);
    return payload ? clonePayload(payload) : undefined;
  }

  /** Resolves with the person's answers, or a decline when skipped, expired, or cancelled. */
  holdQuestion(dispatch: OrchestrationDispatchRecord, input: HoldNativeQuestionInput): Promise<AgentRuntimeResponse> {
    if (input.signal.aborted || !ACTIVE_DISPATCH_STATUSES.has(dispatch.status) || dispatch.releasedAt ||
        input.questions.length === 0) {
      return Promise.resolve(DECLINE);
    }
    const requestId = `wq_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const capability = this.deps.store.getDispatchCapability(dispatch.id);
    const driverRedact = input.redact ?? ((text: string) => text);
    const redact = (text: string): string =>
      this.deps.store.redactDispatchCredentials(redactDispatchCapability(driverRedact(text), capability));
    const questions: AgentQuestion[] = input.questions.map((question) => ({
      id: question.id,
      header: redact(question.header),
      prompt: redact(question.prompt),
      allowOther: question.allowOther,
      ...(question.multiSelect ? { multiSelect: true } : {}),
      options: question.options.map((option) => ({
        label: redact(option.label),
        description: redact(option.description),
      })),
    }));
    const payload: WorkerNativeQuestionPayload = {
      requestId,
      dispatchId: dispatch.id,
      taskId: dispatch.taskId,
      runId: dispatch.runId,
      workerHandle: dispatch.assigneeHandle,
      provider: input.provider,
      method: input.method,
      questions,
      status: 'pending',
      createdAt: new Date(this.clock()).toISOString(),
      resolvedAt: null,
      resolvedBy: null,
      answers: null,
      reason: null,
    };

    const response = new Promise<AgentRuntimeResponse>((resolve) => {
      const timer = this.holdTimeoutMs > 0
        ? setTimeout(() => this.expireQuestion(requestId, 'Worker question timed out'), this.holdTimeoutMs)
        : null;
      timer?.unref?.();
      const onAbort = () => this.expireQuestion(requestId, 'Worker turn ended before the question was answered');
      input.signal.addEventListener('abort', onAbort, { once: true });
      this.openByRequestId.set(requestId, {
        payload, resolve, redact, timer,
        cleanupSignal: () => input.signal.removeEventListener('abort', onAbort),
      });
      this.historyByRequestId.set(requestId, clonePayload(payload));
    });

    this.deps.store.updateDispatchObservation(dispatch.id, 'observed', {
      reason: `Waiting for the person to answer (${requestId})`,
      refreshHeartbeat: true,
    });
    if (!this.deps.hasOpenApprovalForDispatch(dispatch.id)) {
      this.deps.store.updateDispatchStage(dispatch.id, 'waiting_input');
    }
    this.deps.onChanged?.('worker-question:requested', dispatch.runId);
    return response;
  }

  answer(input: {
    id: string;
    dispatchId?: string;
    answers: Record<string, string[]> | null;
    from?: string;
  }): { question: WorkerNativeQuestionPayload } {
    const entry = this.resolveHeldEntry(input.id, input.dispatchId);
    let cleanAnswers: Record<string, string[]> | null = null;
    let recordedAnswers: Record<string, string[]> | null = null;
    if (input.answers !== null) {
      cleanAnswers = {};
      recordedAnswers = {};
      for (const question of entry.payload.questions) {
        const label = question.header || question.prompt || question.id;
        const raw = input.answers[question.id];
        if (!Array.isArray(raw)) {
          throw new OrchestrationError('invalid_argument', `Missing answer for question "${label}".`);
        }
        const values = raw
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.trim())
          .filter(Boolean);
        if (values.length === 0) {
          throw new OrchestrationError('invalid_argument', `Answer cannot be empty for question "${label}".`);
        }
        if (values.length > 1 && !question.multiSelect) {
          throw new OrchestrationError('invalid_argument', `Question "${label}" takes a single answer.`);
        }
        if (!question.allowOther && question.options.length > 0) {
          const allowed = new Set(question.options.map((option) => option.label));
          const invalid = values.find((value) => !allowed.has(value));
          if (invalid !== undefined) {
            throw new OrchestrationError('invalid_argument', `Answer "${invalid}" is not an option for question "${label}".`);
          }
        }
        cleanAnswers[question.id] = values;
        recordedAnswers[question.id] = values.map((value) => entry.redact(value));
      }
    }

    this.removeOpenEntry(entry);
    entry.payload.status = cleanAnswers ? 'answered' : 'skipped';
    entry.payload.resolvedAt = new Date(this.clock()).toISOString();
    entry.payload.resolvedBy = input.from?.trim() || 'user';
    entry.payload.answers = recordedAnswers;
    entry.payload.reason = cleanAnswers ? null : 'Skipped by user';
    this.historyByRequestId.set(entry.payload.requestId, clonePayload(entry.payload));
    this.restoreDispatchStage(entry.payload.dispatchId);
    if (recordedAnswers) {
      try {
        this.deps.onAnswered?.(clonePayload(entry.payload), recordedAnswers);
      } catch (error) {
        console.warn('[orchestration] worker native question notice failed:', error);
      }
    }
    entry.resolve(cleanAnswers ? { answers: cleanAnswers } : DECLINE);
    this.deps.onChanged?.(cleanAnswers ? 'worker-question:answered' : 'worker-question:skipped', entry.payload.runId);
    return { question: clonePayload(entry.payload) };
  }

  cancelForDispatch(dispatchId: string, reason = 'Dispatch ended'): number {
    let count = 0;
    for (const entry of [...this.openByRequestId.values()]) {
      if (entry.payload.dispatchId !== dispatchId) continue;
      this.expireQuestion(entry.payload.requestId, reason);
      count += 1;
    }
    return count;
  }

  cancelForWorker(workerHandle: string, reason = 'Worker exited'): number {
    let count = 0;
    for (const entry of [...this.openByRequestId.values()]) {
      if (entry.payload.workerHandle !== workerHandle) continue;
      this.expireQuestion(entry.payload.requestId, reason);
      count += 1;
    }
    return count;
  }

  dispose(): void {
    for (const entry of [...this.openByRequestId.values()]) {
      this.expireQuestion(entry.payload.requestId, 'Application stopped');
    }
    this.openByRequestId.clear();
  }

  private resolveHeldEntry(idOrTarget: string, expectedDispatchId?: string): HeldNativeQuestionEntry {
    const raw = idOrTarget.trim();
    const target = stripDispatchPrefix(raw);
    const expected = expectedDispatchId?.trim() ? stripDispatchPrefix(expectedDispatchId.trim()) : undefined;
    const checkDispatch = (entry: HeldNativeQuestionEntry): HeldNativeQuestionEntry => {
      if (expected && entry.payload.dispatchId !== expected &&
          this.deps.store.resolveDispatchLineage(expected)?.id !== entry.payload.dispatchId) {
        throw new OrchestrationError(
          'invalid_argument',
          `Worker question ${entry.payload.requestId} belongs to dispatch ${entry.payload.dispatchId}, not ${expected}.`,
        );
      }
      return entry;
    };
    const direct = this.openByRequestId.get(target);
    if (direct) return checkDispatch(direct);
    const historical = this.historyByRequestId.get(target);
    if (historical && historical.status !== 'pending') {
      throw new OrchestrationError('answer_conflict', `Worker question ${target} is already ${historical.status}.`, {
        requestId: target, status: historical.status,
      });
    }
    const latestId = this.deps.store.resolveDispatchLineage(target)?.id;
    const matches = [...this.openByRequestId.values()].filter((entry) =>
      entry.payload.dispatchId === target ||
      (latestId !== undefined && entry.payload.dispatchId === latestId) ||
      entry.payload.workerHandle === target);
    if (matches.length === 1) return checkDispatch(matches[0]!);
    if (matches.length > 1) {
      throw new OrchestrationError('invalid_argument', `Multiple open Worker questions match ${raw}; specify the request id.`);
    }
    throw new OrchestrationError('not_found', `Worker question not found: ${raw}`);
  }

  private expireQuestion(requestId: string, reason: string): void {
    const entry = this.openByRequestId.get(requestId);
    if (!entry) return;
    this.removeOpenEntry(entry);
    entry.payload.status = 'expired';
    entry.payload.resolvedAt = new Date(this.clock()).toISOString();
    entry.payload.reason = reason;
    this.historyByRequestId.set(requestId, clonePayload(entry.payload));
    entry.resolve(DECLINE);
    this.restoreDispatchStage(entry.payload.dispatchId, reason);
    this.deps.onChanged?.('worker-question:expired', entry.payload.runId);
  }

  private restoreDispatchStage(dispatchId: string, reason?: string): void {
    const dispatch = this.deps.store.getDispatchContext(dispatchId);
    if (!dispatch || !ACTIVE_DISPATCH_STATUSES.has(dispatch.status) || dispatch.releasedAt) return;
    if (this.deps.hasOpenApprovalForDispatch(dispatchId)) {
      this.deps.store.updateDispatchStage(dispatchId, 'waiting_permission');
      return;
    }
    if (this.hasOpenQuestionForDispatch(dispatchId) ||
        this.deps.store.listQuestions({ dispatchId, status: 'pending' }).length > 0) {
      this.deps.store.updateDispatchStage(dispatchId, 'waiting_input');
      return;
    }
    if (dispatch.stage === 'waiting_input') {
      this.deps.store.updateDispatchObservation(dispatchId, 'observed', {
        ...(reason ? { reason } : {}),
        refreshHeartbeat: true,
      });
      this.deps.store.updateDispatchStage(dispatchId, 'working');
    }
  }

  private removeOpenEntry(entry: HeldNativeQuestionEntry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.cleanupSignal?.();
    this.openByRequestId.delete(entry.payload.requestId);
  }
}
