import { createHash } from 'node:crypto';
import { OrchestrationError } from './orchestration-types.js';

/**
 * Write actions a caller may retry with the same `requestId` after a dropped connection or a
 * repeated click: the retry returns the first call's result instead of running the action again.
 */
export const IDEMPOTENT_ORCHESTRATION_ACTIONS: ReadonlySet<string> = new Set([
  'worker-start', 'worker-integrate', 'run-finalize', 'worker-release', 'approve', 'deny',
]);

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CAPACITY = 500;

/** Fields that change how a result is printed, not what the action does. */
const PRESENTATION_FIELDS = new Set(['requestId', 'receiptText', 'full']);

interface Receipt<T> {
  payloadHash: string;
  createdAt: number;
  /** Settles with the first call's outcome; concurrent retries share it. */
  outcome: Promise<T>;
  settled: boolean;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function requestPayloadHash(payload: Record<string, unknown>): string {
  const material = Object.fromEntries(Object.entries(payload).filter(([key]) => !PRESENTATION_FIELDS.has(key)));
  return createHash('sha256').update(canonicalJson(material)).digest('hex');
}

/** The caller's `requestId`, or null when the call opted out of idempotency. */
export function parseRequestId(payload: Record<string, unknown>): string | null {
  const raw = payload.requestId;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || !REQUEST_ID.test(raw)) {
    throw new OrchestrationError('invalid_argument', 'requestId must be 8-128 characters of letters, digits, ".", "_", ":" or "-".');
  }
  return raw;
}

/**
 * Receipts keyed by (action, caller fingerprint, requestId). Only successful outcomes are kept, so
 * a retry after a failure runs the action again; a retry with a different payload is refused with
 * `request_mismatch`. Receipts live for the app's lifetime, bounded by age and count.
 */
export class RequestReceipts<T> {
  private readonly receipts = new Map<string, Receipt<T>>();

  constructor(
    private readonly clock: () => number = Date.now,
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly capacity = DEFAULT_CAPACITY,
  ) {}

  async run(
    key: { action: string; caller: string; requestId: string },
    payload: Record<string, unknown>,
    execute: () => Promise<T>,
  ): Promise<{ value: T; replayed: boolean }> {
    this.prune();
    const id = `${key.action}\u0000${key.caller}\u0000${key.requestId}`;
    const payloadHash = requestPayloadHash(payload);
    const existing = this.receipts.get(id);
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new OrchestrationError('request_mismatch', `requestId ${key.requestId} was already used for a different ${key.action} request.`);
      }
      return { value: await existing.outcome, replayed: true };
    }
    const receipt: Receipt<T> = { payloadHash, createdAt: this.clock(), outcome: execute(), settled: false };
    this.receipts.set(id, receipt);
    try {
      const value = await receipt.outcome;
      receipt.settled = true;
      return { value, replayed: false };
    } catch (error) {
      if (this.receipts.get(id) === receipt) this.receipts.delete(id);
      throw error;
    }
  }

  get size(): number {
    return this.receipts.size;
  }

  private prune(): void {
    const oldest = this.clock() - this.ttlMs;
    for (const [id, receipt] of this.receipts) {
      if (receipt.settled && receipt.createdAt < oldest) this.receipts.delete(id);
    }
    if (this.receipts.size < this.capacity) return;
    for (const [id, receipt] of this.receipts) {
      if (this.receipts.size < this.capacity) break;
      if (receipt.settled) this.receipts.delete(id);
    }
  }
}
