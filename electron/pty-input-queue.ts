import { setTimeout as delay } from 'node:timers/promises';
import { PTY_INPUT_MAX_BYTES } from './pty-input-limiter.js';

export const PTY_INPUT_PENDING_BYTES = 2 * 1024 * 1024;
// At most 50 writes in any wall-clock second, below the daemon's 60-event guard.
const INPUT_INTERVAL_MS = 20;
interface Stream {
  tail: Promise<void>;
  bytes: number;
  inputs: number;
  nextAt: number;
  abort: AbortController;
  error?: Error;
}

/** Transport writes are never replayed: a lost ACK may already have reached the PTY. */
export class PtyInputQueue {
  private readonly streams = new Map<string, Stream>();
  private stopped = false;
  constructor(
    private readonly now = () => performance.now(),
    private readonly wait = (ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }),
  ) {}

  enqueue(id: string, data: string, send: (chunk: string, signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('终端连接已关闭，输入已取消'));
    let stream = this.streams.get(id);
    if (!stream) {
      stream = { tail: Promise.resolve(), bytes: 0, inputs: 0, nextAt: 0, abort: new AbortController() };
      this.streams.set(id, stream);
    }
    if (stream.error) return Promise.reject(stream.error);
    const bytes = Buffer.byteLength(data, 'utf8');
    if (stream.bytes + bytes > PTY_INPUT_PENDING_BYTES || stream.inputs >= 1024) {
      // Reject this entire input before scheduling any of it; do not log prompt text.
      return Promise.reject(new Error('待发送输入超过 2 MiB 或 1024 次；本次输入未排队，请改用文件'));
    }
    stream.bytes += bytes;
    stream.inputs++;
    const state = stream;
    const job = state.tail.then(async () => {
      try {
        for (const chunk of utf8InputChunks(data)) {
          if (state.error) throw state.error;
          // Recheck after waking: timers can fire early and clocks can move.
          for (;;) {
            const remaining = state.nextAt - this.now();
            if (remaining <= 0) break;
            await this.wait(remaining, state.abort.signal);
          }
          if (state.error) throw state.error;
          await send(chunk, state.abort.signal);
          // Pace from the ACK, not from before a potentially slow client acquisition.
          state.nextAt = this.now() + INPUT_INTERVAL_MS;
        }
        if (state.error) throw state.error;
      } catch {
        state.error ??= new Error('终端输入中断，后续输入已停止；可能已写入部分内容，请核对后重新打开终端，勿整段重发');
        state.abort.abort();
        throw state.error;
      }
    }).finally(() => { state.bytes -= bytes; state.inputs--; });
    // A rejected write cancels already queued and future input until a new terminal is created.
    state.tail = job.catch(() => {});
    return job;
  }

  cancel(id: string): void {
    let stream = this.streams.get(id);
    if (!stream) {
      stream = { tail: Promise.resolve(), bytes: 0, inputs: 0, nextAt: 0, abort: new AbortController() };
      this.streams.set(id, stream);
    }
    stream.error = new Error('终端已关闭，待发送输入已取消');
    stream.abort.abort();
  }

  cancelAll(): void {
    this.stopped = true;
    for (const id of this.streams.keys()) this.cancel(id);
    this.streams.clear();
  }

  /** Only after confirmed exit/termination: keep cancellation until the process is gone. */
  release(id: string): void {
    this.cancel(id);
    this.streams.delete(id);
  }
}

/** Keep Unicode scalar values intact; terminal escape sequences remain an unchanged byte stream. */
function* utf8InputChunks(data: string): Generator<string> {
  let chunk = '';
  let bytes = 0;
  for (const point of data) {
    const size = Buffer.byteLength(point, 'utf8');
    if (bytes + size > PTY_INPUT_MAX_BYTES) {
      yield chunk;
      chunk = '';
      bytes = 0;
    }
    chunk += point;
    bytes += size;
  }
  if (chunk) yield chunk;
}
