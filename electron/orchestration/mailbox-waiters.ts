import { ORCHESTRATION_MESSAGE_WAIT_DEFAULT_TIMEOUT_MS } from './orchestration-types.js';

export interface WaitForMessageOptions {
  typeFilter?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  consumerHandle?: string;
}

export class MessageWake {
  private readonly sharedTakes = new Map<string, unknown>();

  share<T>(key: string, take: () => T, onReplay?: (first: T) => T): T {
    if (this.sharedTakes.has(key)) {
      const first = this.sharedTakes.get(key) as T;
      return onReplay ? onReplay(first) : first;
    }
    const result = take();
    this.sharedTakes.set(key, result);
    return result;
  }
}

export interface WaiterEntry {
  typeFilter: string[] | undefined;
  consumerHandle: string | undefined;
  resolve: (result: MessageWake | 'timed_out' | 'cancelled') => void;
  cleanup: () => void;
}

export class RuntimeMessageWaiters {
  private readonly waitersByHandle = new Map<string, Set<WaiterEntry>>();

  wait(
    handle: string,
    options?: WaitForMessageOptions
  ): Promise<MessageWake | 'timed_out' | 'cancelled'> {
    if (options?.signal?.aborted) {
      return Promise.resolve('cancelled');
    }

    const typeFilter = options?.typeFilter?.length ? options.typeFilter : undefined;
    const timeoutMs = options?.timeoutMs ?? ORCHESTRATION_MESSAGE_WAIT_DEFAULT_TIMEOUT_MS;
    if (timeoutMs <= 0) {
      return Promise.resolve('timed_out');
    }

    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      let waiters = this.waitersByHandle.get(handle);
      if (!waiters) {
        waiters = new Set();
        this.waitersByHandle.set(handle, waiters);
      }

      const cleanup = () => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        options?.signal?.removeEventListener('abort', onAbort);
        waiters?.delete(entry);
        if (waiters && waiters.size === 0) {
          this.waitersByHandle.delete(handle);
        }
      };

      const finish = (outcome: MessageWake | 'timed_out' | 'cancelled') => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(outcome);
      };

      const onAbort = () => finish('cancelled');
      options?.signal?.addEventListener('abort', onAbort, { once: true });

      const entry: WaiterEntry = {
        typeFilter,
        consumerHandle: options?.consumerHandle,
        resolve: finish,
        cleanup,
      };
      waiters.add(entry);

      if (Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => finish('timed_out'), timeoutMs);
        timer.unref?.();
      }
    });
  }

  getWaiters(handle: string): ReadonlySet<WaiterEntry> | undefined {
    return this.waitersByHandle.get(handle);
  }

  hasMatchingWaiter(handle: string, messageType: string): boolean {
    const waiters = this.waitersByHandle.get(handle);
    if (!waiters) return false;
    for (const w of waiters) {
      if (!w.typeFilter || w.typeFilter.includes(messageType)) {
        return true;
      }
    }
    return false;
  }

  hasUnfilteredWaiter(handle: string): boolean {
    const waiters = this.waitersByHandle.get(handle);
    if (!waiters) return false;
    for (const w of waiters) {
      if (!w.typeFilter) return true;
    }
    return false;
  }

  hasActiveWaiterFor(handleOrConsumer: string): boolean {
    if (!handleOrConsumer) return false;
    const direct = this.waitersByHandle.get(handleOrConsumer);
    if (direct && direct.size > 0) return true;
    for (const waiters of this.waitersByHandle.values()) {
      for (const entry of waiters) {
        if (entry.consumerHandle === handleOrConsumer) {
          return true;
        }
      }
    }
    return false;
  }

  notify(handle: string, messageType: string): boolean {
    const waiters = this.waitersByHandle.get(handle);
    if (!waiters || waiters.size === 0) {
      return false;
    }
    const matching = [...waiters].filter(
      (entry) => !entry.typeFilter || entry.typeFilter.includes(messageType)
    );
    if (matching.length === 0) {
      return false;
    }
    const wake = new MessageWake();
    for (const entry of matching) {
      entry.resolve(wake);
    }
    return true;
  }

  notifyPrefix(prefix: string, messageType: string): number {
    let notified = 0;
    const handles = [...this.waitersByHandle.keys()].filter((handle) => handle.startsWith(prefix));
    for (const handle of handles) {
      if (this.notify(handle, messageType)) {
        notified += 1;
      }
    }
    return notified;
  }

  cancel(handle: string): void {
    const waiters = this.waitersByHandle.get(handle);
    if (!waiters) return;
    for (const entry of [...waiters]) {
      entry.resolve('cancelled');
    }
  }

  cancelPrefix(prefix: string): void {
    for (const handle of [...this.waitersByHandle.keys()]) {
      if (handle.startsWith(prefix)) {
        this.cancel(handle);
      }
    }
  }

  cancelConsumer(consumerHandle: string): void {
    if (!consumerHandle) return;
    for (const waiters of [...this.waitersByHandle.values()]) {
      for (const entry of [...waiters]) {
        if (entry.consumerHandle === consumerHandle) {
          entry.resolve('cancelled');
        }
      }
    }
  }

  dispose(): void {
    for (const handle of [...this.waitersByHandle.keys()]) {
      this.cancel(handle);
    }
  }
}
