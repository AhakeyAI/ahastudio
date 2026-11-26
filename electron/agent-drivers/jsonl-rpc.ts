// Shared JSON-lines RPC transport for native agent drivers (ACP over JSON-RPC 2.0, Pi typed commands).
// Adapted from Orca (MIT, Copyright (c) 2026 Lovecast Inc.):
// - src/main/jsonl-rpc/peer.ts, src/main/jsonl-rpc/peer-reply.ts
// - src/main/acp/transport/acp-json-rpc-peer.ts
import type { Readable, Writable } from 'node:stream';

export type JsonlRecord = Record<string, unknown>;
export type JsonlRpcId = string | number;

/** The remote answered the call with an error; the request itself was delivered. */
export class JsonlRpcError extends Error {
  constructor(message: string, readonly code: number | null = null, readonly data: unknown = undefined) {
    super(message);
    this.name = 'JsonlRpcError';
  }
}

/** The stream closed or broke; whether the remote saw the call is unknown. */
export class JsonlRpcClosedError extends Error {
  constructor(message = 'Agent JSON-lines stream closed') {
    super(message);
    this.name = 'JsonlRpcClosedError';
  }
}

/** The call could not be written at all, so the remote never saw it. */
export class JsonlRpcWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonlRpcWriteError';
  }
}

export interface JsonlRpcReply {
  /** Absent for replies the protocol may send without an id (Pi prompt acknowledgements). */
  id?: JsonlRpcId;
  /** Matches the oldest pending call of this method when `id` is absent. */
  method?: string;
  error?: JsonlRpcError;
  value?: unknown;
}

/** How a protocol shapes calls and recognizes their replies. */
export interface JsonlRpcEnvelope {
  nextId(seq: number): JsonlRpcId;
  request(id: JsonlRpcId, method: string, params: JsonlRecord | undefined): JsonlRecord;
  /** The reply a record carries, or null when the record is a request, notification, or event. */
  reply(record: JsonlRecord): JsonlRpcReply | null;
}

const object = (value: unknown): JsonlRecord =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as JsonlRecord : {};

/** JSON-RPC 2.0 with numeric ids, as ACP speaks it. */
export const JSON_RPC_2_ENVELOPE: JsonlRpcEnvelope = {
  nextId: (seq) => seq,
  request: (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }),
  reply: (record) => {
    if (typeof record.method === 'string') return null;
    const id = record.id;
    if (typeof id !== 'number' && typeof id !== 'string') return null;
    if ('error' in record && record.error) {
      const error = object(record.error);
      return {
        id,
        error: new JsonlRpcError(
          typeof error.message === 'string' && error.message ? error.message : 'Agent rejected the request',
          typeof error.code === 'number' ? error.code : null,
          error.data,
        ),
      };
    }
    return { id, value: record.result };
  },
};

/** Pi's `{ type, id }` commands answered by `{ type: 'response', id, command, success, data | error }`. */
export const TYPED_COMMAND_ENVELOPE: JsonlRpcEnvelope = {
  nextId: (seq) => `aha-${seq}`,
  request: (id, method, params) => ({ ...(params ?? {}), type: method, id }),
  reply: (record) => {
    if (record.type !== 'response' || typeof record.command !== 'string') return null;
    const id = typeof record.id === 'string' ? record.id : undefined;
    return record.success === true
      ? { ...(id ? { id } : {}), method: record.command, value: record.data }
      : {
          ...(id ? { id } : {}),
          method: record.command,
          error: new JsonlRpcError(typeof record.error === 'string' && record.error ? record.error : `Agent rejected ${record.command}`),
        };
  },
};

export interface JsonlRpcHandlers {
  /** Every record that is not a reply to one of our calls. */
  onRecord?: (record: JsonlRecord) => void;
  /** Once, when the stream ends or breaks; pending calls have already been rejected. */
  onClose?: (error: Error) => void;
  /** Non-JSON output, oversized lines, and handler failures; never fatal. */
  onDiagnostic?: (message: string) => void;
}

export interface JsonlRpcOptions {
  maxLineBytes?: number;
  requestTimeoutMs?: number | null;
}

interface Pending {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const DEFAULT_MAX_LINE_BYTES = 32 * 1024 * 1024;

/** Transport only: drivers own turns, requests from the agent, and session state. */
export class JsonlRpc {
  private readonly pending = new Map<JsonlRpcId, Pending>();
  private readonly maxLineBytes: number;
  private readonly requestTimeoutMs: number | null;
  private buffer = '';
  private skipping = false;
  private seq = 0;
  private terminal: Error | null = null;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly envelope: JsonlRpcEnvelope,
    private readonly handlers: JsonlRpcHandlers = {},
    options: JsonlRpcOptions = {},
  ) {
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.requestTimeoutMs = options.requestTimeoutMs === undefined ? 30_000 : options.requestTimeoutMs;
    input.setEncoding('utf8');
    input.on('data', this.onData);
    input.once('end', this.onEnd);
    input.once('close', this.onEnd);
    input.on('error', this.onStreamError);
    output.on('error', this.onStreamError);
  }

  get closed(): boolean {
    return this.terminal !== null;
  }

  /** Sends a call and resolves with its reply; `timeoutMs: null` waits for as long as the stream lives. */
  request(method: string, params?: JsonlRecord, options: { timeoutMs?: number | null } = {}): Promise<unknown> {
    if (this.terminal) return Promise.reject(new JsonlRpcWriteError(this.terminal.message));
    const id = this.envelope.nextId(++this.seq);
    const timeoutMs = options.timeoutMs === undefined ? this.requestTimeoutMs : options.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === null ? undefined : setTimeout(() => {
        this.pending.delete(id);
        reject(new JsonlRpcClosedError(`Agent did not answer ${method} in time`));
      }, timeoutMs);
      timer?.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      this.write(this.envelope.request(id, method, params)).catch((error: Error) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        entry.reject(error);
      });
    });
  }

  /**
   * Writes one record. Rejects with `JsonlRpcWriteError` when nothing could be handed to the
   * stream, and with `JsonlRpcClosedError` when the stream broke while the line was in flight.
   */
  write(record: JsonlRecord): Promise<void> {
    if (this.terminal) return Promise.reject(new JsonlRpcWriteError(this.terminal.message));
    if (this.output.destroyed || !this.output.writable) return Promise.reject(new JsonlRpcWriteError('Agent input is not writable'));
    let line: string;
    try {
      line = JSON.stringify(record) + '\n';
    } catch (error) {
      return Promise.reject(new JsonlRpcWriteError(error instanceof Error ? error.message : String(error)));
    }
    return new Promise((resolve, reject) => {
      try {
        this.output.write(line, (error) => (error ? reject(new JsonlRpcClosedError(error.message)) : resolve()));
      } catch (error) {
        reject(new JsonlRpcWriteError(error instanceof Error ? error.message : String(error)));
      }
    });
  }

  close(error: Error = new JsonlRpcClosedError()): void {
    if (this.terminal) return;
    this.terminal = error;
    this.input.off('data', this.onData);
    this.input.off('end', this.onEnd);
    this.input.off('close', this.onEnd);
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.buffer = '';
    try {
      this.handlers.onClose?.(error);
    } catch (failure) {
      this.diagnose(`close handler failed: ${String(failure)}`);
    }
  }

  private readonly onData = (chunk: string): void => {
    let start = 0;
    for (let index = chunk.indexOf('\n'); index !== -1; index = chunk.indexOf('\n', start)) {
      const piece = chunk.slice(start, index);
      start = index + 1;
      if (this.skipping) {
        this.skipping = false;
        continue;
      }
      const line = this.buffer + piece;
      this.buffer = '';
      if (Buffer.byteLength(line) > this.maxLineBytes) {
        this.diagnose(`Skipped an agent line over ${this.maxLineBytes} bytes`);
        continue;
      }
      this.line(line);
      if (this.terminal) return;
    }
    if (this.skipping) return;
    this.buffer += chunk.slice(start);
    if (Buffer.byteLength(this.buffer) > this.maxLineBytes) {
      this.diagnose(`Skipped an agent line over ${this.maxLineBytes} bytes`);
      this.buffer = '';
      this.skipping = true;
    }
  };

  private readonly onEnd = (): void => {
    const tail = this.buffer.trim();
    this.buffer = '';
    if (tail && !this.skipping) this.line(tail);
    this.close(new JsonlRpcClosedError());
  };

  private readonly onStreamError = (error: Error): void => this.close(new JsonlRpcClosedError(error.message));

  private line(raw: string): void {
    const text = raw.replace(/\r$/u, '').trim();
    if (!text) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.diagnose('Ignored non-JSON agent output');
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.diagnose('Ignored a non-object agent record');
      return;
    }
    const record = parsed as JsonlRecord;
    const reply = this.envelope.reply(record);
    if (reply && this.settle(reply)) return;
    try {
      this.handlers.onRecord?.(record);
    } catch (error) {
      this.diagnose(`record handler failed: ${String(error)}`);
    }
  }

  private settle(reply: JsonlRpcReply): boolean {
    let id = reply.id;
    if (id === undefined && reply.method) {
      for (const [key, entry] of this.pending) {
        if (entry.method === reply.method) {
          id = key;
          break;
        }
      }
    }
    const entry = id === undefined ? undefined : this.pending.get(id);
    if (!entry || id === undefined) return reply.id !== undefined;
    if (reply.method && reply.method !== entry.method) {
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new JsonlRpcError(`Reply to ${entry.method} named ${reply.method}`));
      return true;
    }
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (reply.error) entry.reject(reply.error);
    else entry.resolve(reply.value);
    return true;
  }

  private diagnose(message: string): void {
    try {
      this.handlers.onDiagnostic?.(message);
    } catch {
      // Diagnostics never break the transport.
    }
  }
}
