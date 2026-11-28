import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { OrchestrationError } from './orchestration-types.js';
import type { OrchestrationStore } from './orchestration-store.js';

export type CleanupOutboxKind = 'worker.release' | 'review_worktree.cleanup' | 'run_branch.cleanup';
const kinds: ReadonlySet<CleanupOutboxKind> = new Set(['worker.release', 'review_worktree.cleanup', 'run_branch.cleanup']);
export function assertCleanupKind(kind: CleanupOutboxKind) {
  if (!kinds.has(kind)) throw new CleanupAttention('Unknown cleanup kind');
}
export interface CleanupIntent {
  kind: CleanupOutboxKind;
  runId: string;
  dispatchId?: string;
  repoRootPath: string;
  worktreePath: string;
  worktreeBranch: string | null;
  deleteBranch?: boolean;
  expectedBranchOid?: string;
  expectedReviewHead?: string;
  // Only verified integration or explicit force can discard an unmerged branch.
  allowUnmerged?: boolean;
}
export interface OrchestrationCleanupOutboxEntry extends CleanupIntent {
  id: string;
  status: 'pending' | 'done' | 'needs_attention';
  attempts: number;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt?: number;
  lastError?: string;
  locked?: boolean;
}
export function pathKey(path: string): string {
  return process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
}
export class CleanupAttention extends OrchestrationError {
  constructor(message = 'Cleanup needs attention') { super('operation_rejected', message); }
}
export class CleanupLocked extends CleanupAttention {}
// Git can remove the worktree and still decline the branch deletion. The caller
// gets that partial result; the durable intent does not become done.
export class CleanupBranchRetained extends Error {
  constructor(readonly reason: unknown) { super(String(reason)); }
}
export class CleanupDeferred extends Error {}
export interface CleanupResult { removed: boolean; removedBranch: boolean }
export interface CleanupHost {
  store: OrchestrationStore;
  now(): number;
  disposed(): boolean;
  guard(intent: CleanupIntent): void;
  lock(entry: CleanupIntent, fn: () => Promise<void>): Promise<void>;
  execute(entry: CleanupIntent, force: boolean, guard: () => void): Promise<CleanupResult>;
}

export class CleanupOutbox {
  constructor(private readonly host: CleanupHost) {}
  private readonly busy = new Set<string>();
  private scanning = false;

  private check(intent: CleanupIntent) {
    assertCleanupKind(intent.kind);
    if (this.host.disposed()) throw new CleanupDeferred('Cleanup suspended during shutdown');
    this.host.guard(intent);
  }

  async submit(intent: CleanupIntent, force = false, manualForce = false): Promise<CleanupResult> {
    this.check(intent);
    const { store } = this.host;
    const now = this.host.now();
    const entries = store.listCleanupEntries().filter(e => e.kind === intent.kind && pathKey(e.repoRootPath) === pathKey(intent.repoRootPath));
    const previous = entries.find(e => pathKey(e.worktreePath) === pathKey(intent.worktreePath));
    if (intent.deleteBranch && entries.some(e => e.id !== previous?.id && e.status !== 'done' && e.deleteBranch && e.worktreeBranch === intent.worktreeBranch)) {
      throw new CleanupAttention('Branch already has an outstanding cleanup intent');
    }
    // A later wave may legitimately reuse a completed resource name. Never rebase an outstanding CAS.
    const unlock = manualForce && force && previous?.locked && previous.dispatchId === intent.dispatchId && previous.worktreeBranch === intent.worktreeBranch && (!previous.deleteBranch || previous.expectedBranchOid === intent.expectedBranchOid);
    if (!unlock && previous && previous.status !== 'done' && (previous.dispatchId !== intent.dispatchId || previous.runId !== intent.runId || previous.worktreeBranch !== intent.worktreeBranch || previous.expectedBranchOid !== intent.expectedBranchOid || !!previous.deleteBranch !== !!intent.deleteBranch)) throw new CleanupAttention('Another cleanup intent already owns this resource');
    const entry: OrchestrationCleanupOutboxEntry = previous && previous.status !== 'done' && !unlock ? previous : {
      ...intent, id: previous?.id ?? randomUUID(), status: 'pending', attempts: 0, createdAt: now, updatedAt: now,
    };
    if (entry.status === 'needs_attention') throw new CleanupAttention(entry.lastError);
    store.runMutation(() => store.saveCleanupEntry(entry));
    try {
      return await this.attempt(entry, force && (!previous || previous.status === 'done' || !!unlock));
    } catch (error) {
      if (error instanceof CleanupBranchRetained) return { removed: true, removedBranch: false };
      throw error;
    }
  }

  private async attempt(entry: OrchestrationCleanupOutboxEntry, force: boolean) {
    const { store } = this.host;
    if (this.busy.has(entry.id)) throw new CleanupDeferred('Cleanup already in progress');
    this.busy.add(entry.id);
    try {
      await store.flushDurable();
      const guard = () => this.check(entry);
      let result: CleanupResult;
      try {
        guard();
        result = await this.host.execute(entry, force, guard);
      } catch (err) {
        if (err instanceof CleanupDeferred) throw err;
        const attempts = entry.attempts + 1;
        const reason = err instanceof CleanupBranchRetained ? err.reason : err;
        const attention = reason instanceof CleanupAttention || attempts >= 6;
        store.saveCleanupEntry({ ...entry, attempts, status: attention ? 'needs_attention' : 'pending',
          locked: err instanceof CleanupLocked, lastError: String(err), updatedAt: this.host.now(), nextAttemptAt: attention ? undefined : this.host.now() + 1000 * 2 ** (attempts - 1) });
        await store.flushDurable();
        throw err;
      }
      store.runMutation(() => {
        if (entry.dispatchId) store.markDispatchReleased(entry.dispatchId, { keepPane: true, keepWorktree: false });
        else if (store.getRun(entry.runId)?.integrationStatus === 'finalized') {
          store.updateRunIntegrationState(entry.runId, { integrationWorktreePath: null, ...(entry.deleteBranch ? { integrationBranch: null } : {}) });
        }
        store.saveCleanupEntry({ ...entry, status: 'done', attempts: entry.attempts + 1, updatedAt: this.host.now(), lastError: undefined, nextAttemptAt: undefined });
      });
      await store.flushDurable();
      return result;
    } finally { this.busy.delete(entry.id); }
  }

  async recover(startup = false) {
    if (this.scanning || this.host.disposed()) return;
    this.scanning = true;
    try {
      for (const e of this.host.store.listCleanupEntries()) {
        if (this.host.disposed()) break;
        if (e.status !== 'pending' || (!startup && (e.nextAttemptAt ?? 0) > this.host.now())) continue;
        try {
          await this.host.lock(e, async () => {
            const current = this.host.store.listCleanupEntries().find(item => item.id === e.id);
            if (current?.status === 'pending' && current.updatedAt === e.updatedAt) await this.attempt(current, false);
          });
        } catch { /* Contended locks / claims wait; execution failures are recorded by attempt. */ }
      }
    } finally { this.scanning = false; }
  }
}
