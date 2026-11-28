import { randomUUID } from 'node:crypto';
import type { AgentStatusStore } from '../agent/agent-status-store.js';
import {
  AGENT_DRIVER_IDS, driverCapabilities, type AgentDriverId, type HookApprovalDialect,
} from '../agent-drivers/driver-capabilities.js';
import { approvalToolName, headlessWorkerDriver } from './headless-workers.js';
import { ACTIVE_DISPATCH_STATUSES } from './orchestration-lifecycle-graph.js';
import type { OrchestrationStore } from './orchestration-store.js';
import {
  OrchestrationError,
  type OrchestrationDispatchRecord,
  type OrchestrationMessageType,
  type WorkerApprovalPayload,
} from './orchestration-types.js';
import { redactDispatchCapability } from './worker-dispatch-preamble.js';

export const DEFAULT_APPROVAL_HOLD_TIMEOUT_MS = 115_000;

interface HeldApprovalEntry {
  payload: WorkerApprovalPayload;
  resolveDecision: (allow: boolean, reason?: string, updatedInput?: Record<string, unknown>) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanupSignal?: () => void;
}

export interface PermissionHookInterceptInput {
  ptyId: string;
  providerHint?: string;
  eventName: string;
  rawPayload: Record<string, unknown>;
  toolName?: string;
  toolInput?: string;
  message?: string;
  signal: AbortSignal;
}

export interface PermissionApprovalManagerDependencies {
  store: OrchestrationStore;
  agentStatusStore: AgentStatusStore;
  notifyMailbox: (mailboxHandle: string, type: OrchestrationMessageType) => void;
  onChanged?: (reason: string, runId: string) => void;
  /** Receives a copy of the approval each time it is created or resolved. */
  onApprovalChanged?: (approval: WorkerApprovalPayload) => void;
  resolveRoleName?: (dispatch: OrchestrationDispatchRecord) => string | null;
  cliCommand?: string;
  holdTimeoutMs?: number;
  now?: () => number;
}

function shouldHoldPermissionEvent(
  eventName: string,
  raw: Record<string, unknown>,
  toolName?: string
): boolean {
  if (eventName === 'PermissionRequest') {
    return true;
  }
  if (eventName === 'BeforeTool') {
    return Boolean(
      raw.requiresApproval === true ||
        raw.requires_approval === true ||
        raw.askPermission === true ||
        raw.ask_permission === true ||
        raw.confirmationDetails != null
    );
  }
  if (eventName === 'PreToolUse') {
    return Boolean(
      toolName === 'ask_permission' ||
        raw.requiresApproval === true ||
        raw.requires_approval === true ||
        raw.permissionPrompt === true ||
        raw.holdForApproval === true
    );
  }
  return false;
}

/** Hook CLIs that are not session drivers, by the dialect their permission hooks read. */
const NON_DRIVER_HOOK_DIALECTS: Readonly<Record<string, HookApprovalDialect>> = {
  agy: 'top-level',
  gemini: 'top-level',
};

/** The stdout shape `provider`'s permission hook expects; Grok, Qwen and other runners read either. */
export function hookApprovalDialectFor(provider: string): HookApprovalDialect {
  const normalized = provider.toLowerCase();
  if ((AGENT_DRIVER_IDS as readonly string[]).includes(normalized)) {
    return driverCapabilities(normalized as AgentDriverId).hookApprovalDialect;
  }
  return NON_DRIVER_HOOK_DIALECTS[normalized] ?? 'combined';
}

export function buildProviderDecisionStdout(
  provider: string,
  eventName: string,
  decision: 'allow' | 'deny',
  reason?: string,
  updatedInput?: Record<string, unknown>
): string {
  const denyMessage = reason?.trim() || 'Denied by coordinator';
  const hookDecision = decision === 'allow'
    ? { behavior: 'allow', ...(updatedInput ? { updatedInput } : {}) }
    : { behavior: 'deny', message: denyMessage };

  switch (hookApprovalDialectFor(provider)) {
    case 'hook-specific':
      if (eventName === 'PreToolUse') {
        return `${JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: decision,
            ...(decision === 'deny' ? { permissionDecisionReason: denyMessage } : {}),
            ...(decision === 'allow' && updatedInput ? { updatedInput } : {}),
          },
        })}
`;
      }
      return `${JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: hookDecision },
      })}
`;
    case 'top-level':
      return `${JSON.stringify(
        decision === 'allow'
          ? { decision: 'allow' }
          : { decision: 'deny', reason: denyMessage }
      )}
`;
    case 'combined':
      return `${JSON.stringify({
        decision,
        ...(decision === 'deny' ? { reason: denyMessage } : {}),
        hookSpecificOutput: { hookEventName: eventName || 'PermissionRequest', decision: hookDecision },
      })}
`;
  }
}

export class PermissionApprovalManager {
  private readonly openByApprovalId = new Map<string, HeldApprovalEntry>();
  private readonly historyByApprovalId = new Map<string, WorkerApprovalPayload>();
  private readonly holdTimeoutMs: number;
  private readonly cliCommand: string;
  private readonly clock: () => number;

  constructor(private readonly deps: PermissionApprovalManagerDependencies) {
    this.holdTimeoutMs = Math.max(500, Math.floor(deps.holdTimeoutMs ?? DEFAULT_APPROVAL_HOLD_TIMEOUT_MS));
    this.cliCommand = deps.cliCommand ?? 'aha';
    this.clock = deps.now ?? (() => Date.now());
  }

  hasOpenApprovalForDispatch(dispatchId: string): boolean {
    for (const entry of this.openByApprovalId.values()) {
      if (entry.payload.dispatchId === dispatchId && entry.payload.status === 'pending') {
        return true;
      }
    }
    return false;
  }

  listOpenApprovals(filter?: { runId?: string; dispatchId?: string }): WorkerApprovalPayload[] {
    return [...this.openByApprovalId.values()]
      .map((e) => ({ ...e.payload }))
      .filter((a) => {
        if (filter?.runId && a.runId !== filter.runId) return false;
        if (filter?.dispatchId && a.dispatchId !== filter.dispatchId) return false;
        return true;
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getApproval(idOrDispatchId: string): WorkerApprovalPayload | undefined {
    const direct = this.openByApprovalId.get(idOrDispatchId)?.payload ?? this.historyByApprovalId.get(idOrDispatchId);
    if (direct) return { ...direct };
    const byDispatch = this.listOpenApprovals({ dispatchId: idOrDispatchId });
    return byDispatch[0] ? { ...byDispatch[0] } : undefined;
  }

  async maybeHoldHookRequest(
    input: PermissionHookInterceptInput
  ): Promise<{ held: false } | { held: true; hookStdout?: string }> {
    if (input.signal.aborted ||
        !shouldHoldPermissionEvent(input.eventName, input.rawPayload, input.toolName)) {
      return { held: false };
    }

    const activeDispatches = this.deps.store.getActiveDispatchesForPane(input.ptyId);
    const dispatch = activeDispatches[activeDispatches.length - 1];
    if (!dispatch) {
      return { held: false };
    }

    const provider =
      input.providerHint ||
      dispatch.cliId ||
      this.deps.agentStatusStore.get(input.ptyId)?.agentId ||
      'claude';
    const decision = await this.holdRequest(dispatch, input, provider);
    const hookStdout = buildProviderDecisionStdout(
      provider, input.eventName, decision.allow ? 'allow' : 'deny', decision.reason, decision.updatedInput,
    );
    return { held: true, ...(hookStdout ? { hookStdout } : {}) };
  }

  async holdCodexRequest(
    dispatch: OrchestrationDispatchRecord,
    input: { method: string; toolInput: string; message?: string; signal: AbortSignal },
  ): Promise<boolean> {
    if (input.signal.aborted || !ACTIVE_DISPATCH_STATUSES.has(dispatch.status)) return false;
    const provider = headlessWorkerDriver(dispatch.assigneeHandle) ?? dispatch.cliId ?? 'codex';
    const decision = await this.holdRequest(dispatch, {
      ptyId: dispatch.assigneeHandle,
      eventName: input.method,
      toolName: approvalToolName(input.method),
      toolInput: input.toolInput,
      message: input.message,
      signal: input.signal,
    }, provider);
    return decision.allow;
  }

  private holdRequest(
    dispatch: OrchestrationDispatchRecord,
    input: Omit<PermissionHookInterceptInput, 'rawPayload'>,
    provider: string,
  ): Promise<{ allow: boolean; reason?: string; updatedInput?: Record<string, unknown> }> {
    const approvalId = `perm_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const nowIso = new Date(this.clock()).toISOString();
    const toolName = input.toolName || 'tool';
    const capability = this.deps.store.getDispatchCapability(dispatch.id);
    const safeToolInput = input.toolInput
      ? redactDispatchCapability(input.toolInput, capability)
      : undefined;
    const safeMessage = input.message
      ? redactDispatchCapability(input.message, capability)
      : undefined;

    const payload: WorkerApprovalPayload = {
      approvalId,
      dispatchId: dispatch.id,
      taskId: dispatch.taskId,
      runId: dispatch.runId,
      workerHandle: dispatch.assigneeHandle,
      ptyId: input.ptyId,
      provider,
      eventName: input.eventName,
      toolName,
      ...(safeToolInput ? { toolInput: safeToolInput } : {}),
      ...(safeMessage ? { message: safeMessage } : {}),
      status: 'pending',
      createdAt: nowIso,
      resolvedAt: null,
      resolvedBy: null,
      reason: null,
    };

    this.deps.store.updateDispatchObservation(dispatch.id, 'permission', {
      reason: `Waiting for coordinator approval (${approvalId}) on ${toolName}`,
      refreshHeartbeat: true,
    });
    this.deps.store.updateDispatchStage(dispatch.id, 'waiting_permission');

    const parentMailbox = this.resolveParentMailbox(dispatch);
    const roleName =
      this.deps.resolveRoleName?.(dispatch)?.trim().replace(/^@+/, '') || null;
    const workerLabel = roleName
      ? `@${roleName} (${dispatch.assigneeHandle}, dispatch ${dispatch.id})`
      : `${dispatch.assigneeHandle} (dispatch ${dispatch.id})`;
    const bodyLines = [
      `Worker ${workerLabel} is requesting permission to run tool "${toolName}".`,
      ...(safeToolInput ? [`Input: ${safeToolInput}`] : []),
      ...(safeMessage ? [`Details: ${safeMessage}`] : []),
      '',
      ...(roleName
        ? [
            `MCP: manage_worker(role="${roleName}", action="approve") or manage_worker(role="${roleName}", action="deny", reason="...")`,
          ]
        : []),
      `Approve: ${this.cliCommand} orchestration approve --id ${approvalId}`,
      `Deny:    ${this.cliCommand} orchestration deny --id ${approvalId} --reason "<reason>"`,
    ];

    this.deps.store.insertMessage({
      runId: dispatch.runId,
      from: `dispatch:${dispatch.id}`,
      to: parentMailbox,
      type: 'escalation',
      priority: 'urgent',
      subject: roleName
        ? `Permission approval needed from @${roleName}: ${toolName} (${approvalId})`
        : `Permission approval needed: ${toolName} (${approvalId})`,
      body: bodyLines.join('\n'),
      payload: JSON.stringify({
        permissionApproval: true,
        advisory: true,
        ...payload,
      }),
      fromRole: roleName ?? undefined,
      mentions: ['coordinator'],
      kind: 'approval',
    });

    const decision = new Promise<{ allow: boolean; reason?: string; updatedInput?: Record<string, unknown> }>((resolve) => {
      const timer = setTimeout(() => {
        this.expireApproval(approvalId, 'Approval hold timed out');
      }, this.holdTimeoutMs);
      timer.unref?.();

      const onAbort = () => {
        this.expireApproval(approvalId, 'Worker approval connection closed');
      };
      if (input.signal.aborted) {
        clearTimeout(timer);
        resolve({ allow: false });
        return;
      }
      input.signal.addEventListener('abort', onAbort, { once: true });

      const entry: HeldApprovalEntry = {
        payload,
        resolveDecision: (allow, reason, updatedInput) => resolve({ allow, reason, updatedInput }),
        timer,
        cleanupSignal: () => input.signal.removeEventListener('abort', onAbort),
      };
      this.openByApprovalId.set(approvalId, entry);
      this.historyByApprovalId.set(approvalId, payload);
    });

    this.deps.notifyMailbox(parentMailbox, 'escalation');
    this.notifyApproval(payload);
    this.deps.onChanged?.('approval:requested', dispatch.runId);

    return decision;
  }

  approve(input: {
    id: string;
    dispatchId?: string;
    from?: string;
    reason?: string;
    updatedInput?: Record<string, unknown>;
  }, callerPaneId?: string): { approval: WorkerApprovalPayload } {
    const entry = this.resolveHeldEntry(input.id, input.dispatchId);
    if (callerPaneId) this.assertApprovalOwner(entry, callerPaneId);
    const nowIso = new Date(this.clock()).toISOString();
    const actor = callerPaneId ?? (input.from?.trim() || 'coordinator');

    this.removeOpenEntry(entry);
    entry.payload.status = 'approved';
    entry.payload.resolvedAt = nowIso;
    entry.payload.resolvedBy = actor;
    entry.payload.reason = input.reason?.trim() || null;
    this.historyByApprovalId.set(entry.payload.approvalId, { ...entry.payload });

    entry.resolveDecision(true, undefined, input.updatedInput);

    const nextPending = this.listOpenApprovals({ dispatchId: entry.payload.dispatchId })[0];
    if (nextPending) {
      if (!entry.payload.eventName.includes('/')) this.deps.agentStatusStore.ingestHookEvent({
        ptyId: entry.payload.ptyId,
        agentId: entry.payload.provider,
        state: 'waiting',
        waitKind: 'permission',
        toolName: nextPending.toolName,
        toolInput: nextPending.toolInput,
      });
      this.deps.store.updateDispatchStage(entry.payload.dispatchId, 'waiting_permission');
    } else {
      if (!entry.payload.eventName.includes('/')) this.deps.agentStatusStore.ingestHookEvent({
        ptyId: entry.payload.ptyId,
        agentId: entry.payload.provider,
        state: 'working',
        toolName: entry.payload.toolName,
        toolInput: entry.payload.toolInput,
      });
      this.deps.store.updateDispatchObservation(entry.payload.dispatchId, 'observed', {
        refreshHeartbeat: true,
      });
      this.deps.store.updateDispatchStage(entry.payload.dispatchId, 'working');
    }
    this.notifyApproval(entry.payload);
    this.deps.onChanged?.('approval:approved', entry.payload.runId);

    return { approval: { ...entry.payload } };
  }

  deny(input: {
    id: string;
    dispatchId?: string;
    from?: string;
    reason?: string;
  }, callerPaneId?: string): { approval: WorkerApprovalPayload } {
    const entry = this.resolveHeldEntry(input.id, input.dispatchId);
    if (callerPaneId) this.assertApprovalOwner(entry, callerPaneId);
    const nowIso = new Date(this.clock()).toISOString();
    const actor = callerPaneId ?? (input.from?.trim() || 'coordinator');
    const reason = input.reason?.trim() || 'Denied by coordinator';

    this.removeOpenEntry(entry);
    entry.payload.status = 'denied';
    entry.payload.resolvedAt = nowIso;
    entry.payload.resolvedBy = actor;
    entry.payload.reason = reason;
    this.historyByApprovalId.set(entry.payload.approvalId, { ...entry.payload });

    entry.resolveDecision(false, reason);

    const nextPending = this.listOpenApprovals({ dispatchId: entry.payload.dispatchId })[0];
    if (nextPending) {
      if (!entry.payload.eventName.includes('/')) this.deps.agentStatusStore.ingestHookEvent({
        ptyId: entry.payload.ptyId,
        agentId: entry.payload.provider,
        state: 'waiting',
        waitKind: 'permission',
        toolName: nextPending.toolName,
        toolInput: nextPending.toolInput,
        message: `Permission denied: ${reason}`,
      });
      this.deps.store.updateDispatchStage(entry.payload.dispatchId, 'waiting_permission');
    } else {
      if (!entry.payload.eventName.includes('/')) this.deps.agentStatusStore.ingestHookEvent({
        ptyId: entry.payload.ptyId,
        agentId: entry.payload.provider,
        state: 'working',
        clearTool: true,
        message: `Permission denied: ${reason}`,
      });
      this.deps.store.updateDispatchObservation(entry.payload.dispatchId, 'observed', {
        refreshHeartbeat: true,
      });
      this.deps.store.updateDispatchStage(entry.payload.dispatchId, 'working');
    }
    this.notifyApproval(entry.payload);
    this.deps.onChanged?.('approval:denied', entry.payload.runId);

    return { approval: { ...entry.payload } };
  }

  cancelForDispatch(dispatchId: string, reason = 'Dispatch ended'): number {
    let count = 0;
    for (const entry of [...this.openByApprovalId.values()]) {
      if (entry.payload.dispatchId !== dispatchId) continue;
      this.expireApproval(entry.payload.approvalId, reason);
      count += 1;
    }
    return count;
  }

  cancelForPane(ptyId: string, reason = 'Terminal exited'): number {
    let count = 0;
    for (const entry of [...this.openByApprovalId.values()]) {
      if (entry.payload.ptyId !== ptyId) continue;
      this.expireApproval(entry.payload.approvalId, reason);
      count += 1;
    }
    return count;
  }

  dispose(): void {
    for (const entry of [...this.openByApprovalId.values()]) {
      this.expireApproval(entry.payload.approvalId, 'Application stopped');
    }
    this.openByApprovalId.clear();
  }

  private assertApprovalOwner(entry: HeldApprovalEntry, callerPaneId: string): void {
    const dispatch = this.deps.store.getDispatchContext(entry.payload.dispatchId);
    const parent = dispatch?.creatorDispatchId
      ? this.deps.store.resolveDispatchLineage(dispatch.creatorDispatchId)
      : undefined;
    const run = this.deps.store.getRun(entry.payload.runId);
    if (
      callerPaneId !== entry.payload.ptyId &&
      (callerPaneId === run?.coordinatorPaneId ||
        (parent && ACTIVE_DISPATCH_STATUSES.has(parent.status) && callerPaneId === parent.assigneePaneId))
    ) return;
    throw new OrchestrationError(
      'operation_rejected',
      'Only the worker’s coordinator or active parent may resolve this approval.'
    );
  }

  private resolveHeldEntry(idOrDispatchId: string, expectedDispatchId?: string): HeldApprovalEntry {
    const rawTrimmed = idOrDispatchId.trim();
    const trimmed = rawTrimmed.startsWith('dispatch:')
      ? rawTrimmed.slice('dispatch:'.length)
      : rawTrimmed;
    const cleanExpectedDispatchId = expectedDispatchId?.trim()
      ? expectedDispatchId.trim().startsWith('dispatch:')
        ? expectedDispatchId.trim().slice('dispatch:'.length)
        : expectedDispatchId.trim()
      : undefined;

    const assertMatchesDispatch = (entry: HeldApprovalEntry): HeldApprovalEntry => {
      if (cleanExpectedDispatchId && entry.payload.dispatchId !== cleanExpectedDispatchId) {
        const latestExpected = this.deps.store.resolveDispatchLineage(cleanExpectedDispatchId);
        if (!latestExpected || latestExpected.id !== entry.payload.dispatchId) {
          throw new OrchestrationError(
            'invalid_argument',
            `Permission approval ${entry.payload.approvalId} belongs to dispatch ${entry.payload.dispatchId}, not ${cleanExpectedDispatchId}.`
          );
        }
      }
      return entry;
    };

    const direct = this.openByApprovalId.get(trimmed);
    if (direct) return assertMatchesDispatch(direct);

    const historical = this.historyByApprovalId.get(trimmed);
    if (historical && historical.status !== 'pending') {
      throw new OrchestrationError(
        'approval_already_resolved',
        `Permission approval ${trimmed} is already ${historical.status}.`,
        { approvalId: trimmed, status: historical.status }
      );
    }

    const latestLineageId = this.deps.store.resolveDispatchLineage(trimmed)?.id;
    const byDispatch = [...this.openByApprovalId.values()].filter(
      (e) =>
        e.payload.dispatchId === trimmed ||
        (latestLineageId !== undefined && e.payload.dispatchId === latestLineageId) ||
        e.payload.ptyId === trimmed
    );
    if (byDispatch.length === 1) {
      return assertMatchesDispatch(byDispatch[0]!);
    }
    if (byDispatch.length > 1) {
      throw new OrchestrationError(
        'invalid_argument',
        `Multiple open approvals match ${rawTrimmed}; specify --id <approvalId>.`
      );
    }

    throw new OrchestrationError(
      'approval_not_found',
      `Permission approval not found: ${rawTrimmed}`
    );
  }

  private expireApproval(approvalId: string, reason: string): void {
    const entry = this.openByApprovalId.get(approvalId);
    if (!entry) return;
    this.removeOpenEntry(entry);
    entry.payload.status = 'expired';
    entry.payload.resolvedAt = new Date(this.clock()).toISOString();
    entry.payload.reason = reason;
    this.historyByApprovalId.set(approvalId, { ...entry.payload });
    entry.resolveDecision(false, reason);
    if (!this.hasOpenApprovalForDispatch(entry.payload.dispatchId)) {
      const dispatch = this.deps.store.getDispatchContext(entry.payload.dispatchId);
      if (
        dispatch &&
        ACTIVE_DISPATCH_STATUSES.has(dispatch.status) &&
        dispatch.stage === 'waiting_permission'
      ) {
        const alive = this.deps.agentStatusStore.get(entry.payload.ptyId);
        if (alive?.state === 'waiting' && alive.waitKind === 'permission') {
          this.deps.agentStatusStore.ingestHookEvent({
            ptyId: entry.payload.ptyId,
            agentId: entry.payload.provider,
            state: 'working',
            clearTool: true,
            message: reason,
          });
        }
        this.deps.store.updateDispatchObservation(dispatch.id, 'observed', { reason, refreshHeartbeat: true });
      }
    }
    this.notifyApproval(entry.payload);
    this.deps.onChanged?.('approval:expired', entry.payload.runId);
  }

  private notifyApproval(payload: WorkerApprovalPayload): void {
    if (!this.deps.onApprovalChanged) return;
    try {
      this.deps.onApprovalChanged({ ...payload });
    } catch (error) {
      console.warn('[orchestration] approval listener failed:', error);
    }
  }

  private removeOpenEntry(entry: HeldApprovalEntry): void {
    clearTimeout(entry.timer);
    entry.cleanupSignal?.();
    this.openByApprovalId.delete(entry.payload.approvalId);
  }

  private resolveParentMailbox(dispatch: OrchestrationDispatchRecord): string {
    if (dispatch.creatorDispatchId) {
      const parent =
        this.deps.store.resolveDispatchLineage(dispatch.creatorDispatchId) ??
        this.deps.store.getDispatchContext(dispatch.creatorDispatchId);
      if (parent && ACTIVE_DISPATCH_STATUSES.has(parent.status)) {
        return `dispatch:${parent.id}`;
      }
    }
    return `run:${dispatch.runId}`;
  }
}
