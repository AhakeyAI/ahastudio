import type { OrchestrationLifecycleStore } from './orchestration-lifecycle-store.js';
import type { OrchestrationMailboxStore } from './orchestration-mailbox-store.js';
import type { OrchestrationSecurityStore } from './orchestration-security-store.js';
import type { OrchestrationStateRepository, OrchestrationStoreState } from './orchestration-state-repository.js';

export interface OrchestrationStoreLimits {
  readonly maxMessagesPerRun: number;
  readonly maxMessages: number;
  readonly maxDeliveries: number;
  readonly maxRuns: number;
}

/** Shared mutation context: every sub-store reads and writes the same state and persistence repository. */
export interface OrchestrationStoreContext {
  readonly repository: OrchestrationStateRepository;
  readonly limits: OrchestrationStoreLimits;
  now(): string;
  readonly lifecycle: OrchestrationLifecycleStore;
  readonly mailbox: OrchestrationMailboxStore;
  readonly security: OrchestrationSecurityStore;
}

export abstract class OrchestrationStoreSlice {
  constructor(protected readonly ctx: OrchestrationStoreContext) {}

  protected get state(): OrchestrationStoreState {
    return this.ctx.repository.state;
  }

  protected get limits(): OrchestrationStoreLimits {
    return this.ctx.limits;
  }

  protected get resolveFile(): (() => string) | undefined {
    return this.ctx.repository.resolveFile;
  }

  protected get lifecycle(): OrchestrationLifecycleStore {
    return this.ctx.lifecycle;
  }

  protected get mailbox(): OrchestrationMailboxStore {
    return this.ctx.mailbox;
  }

  protected get security(): OrchestrationSecurityStore {
    return this.ctx.security;
  }

  protected now(): string {
    return this.ctx.now();
  }

  protected persist(): void {
    this.ctx.repository.persist();
  }
}
