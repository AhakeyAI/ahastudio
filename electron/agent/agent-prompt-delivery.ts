import { PTY_INPUT_MAX_BYTES } from '../pty-input-limiter.js';

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
// Ported from Orca's `agent-prompt-injection.ts`: Win11 ConPTY paste ingest is ~64 B/ms,
// plus a 500ms TUI intercept floor, 45ms/line expansion on Antigravity, and ~3ms/char
// Win32 INPUT_RECORD key-burst consumption on Windows Codex.
const AGENT_PROMPT_SUBMIT_SETTLE_MS = 500;
const WINDOWS_CONPTY_INGEST_BYTES_PER_MS = 64;
const DEFAULT_PASTE_INGEST_BYTES_PER_MS = 4_096;
const ANTIGRAVITY_LINE_SETTLE_MS = 45;
const WINDOWS_INPUT_RECORD_PASTE_MS_PER_CHAR = 3;
const MAX_WINDOWS_INPUT_RECORD_SETTLE_MS = 6_000;
const DEFAULT_HELD_SUBMIT_RETRY_DELAY_MS = 1_200;
const DEFAULT_MAX_HELD_SUBMIT_RETRIES = 3;

const PASTED_CONTENT_PLACEHOLDER_RE = /\[Pasted Content (\d+) chars\](?: #\d+)?/gi;
const INK_PASTED_LINES_PLACEHOLDER_RE = /\[Pasted text #\d+(?: \+\d+ lines)?\]/i;

// Strip C0 and C1 controls except TAB and LF.
// eslint-disable-next-line no-control-regex
const UNSAFE_PASTE_CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export interface AgentPromptPayloadOptions {
  prompt: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  diffSnippet?: string;
}

export interface DeliverPromptOptions extends AgentPromptPayloadOptions {
  ptyId: string;
  submit?: boolean;
  settleDelayMs?: number;
  agentId?: string | null;
  platform?: NodeJS.Platform;
  readScreen?: () => string;
  getLastOutputAtMs?: () => number;
  isPaneAlive?: () => boolean;
  hasTurnStartedOrBlocked?: () => boolean;
  submitRetryDelayMs?: number;
  maxSubmitRetries?: number;
}

export type PtyWriteFn = (
  ptyId: string,
  data: string,
) => Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string };

export function sanitizeBracketedPasteText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(UNSAFE_PASTE_CONTROL_RE, '');
}

function formatLineRange(startLine?: number, endLine?: number): string {
  if (typeof startLine !== 'number' || !Number.isInteger(startLine) || startLine < 1) {
    return '';
  }
  if (typeof endLine === 'number' && Number.isInteger(endLine) && endLine > startLine) {
    return `#L${startLine}-L${endLine}`;
  }
  return `#L${startLine}`;
}

export function formatAgentPromptPayload(opts: AgentPromptPayloadOptions): string {
  const sections: string[] = [];

  if (opts.filePath) {
    const cleanPath = sanitizeBracketedPasteText(opts.filePath).replace(/\n/g, ' ').trim();
    if (cleanPath) {
      const range = formatLineRange(opts.startLine, opts.endLine);
      sections.push(`[文件: ${cleanPath}${range}]`);
    }
  }

  if (opts.diffSnippet) {
    const cleanDiff = sanitizeBracketedPasteText(opts.diffSnippet).trimEnd();
    if (cleanDiff.trim().length > 0) {
      sections.push(`\`\`\`diff\n${cleanDiff}\n\`\`\``);
    }
  }

  const cleanPrompt = sanitizeBracketedPasteText(opts.prompt).trim();
  if (cleanPrompt.length > 0) {
    sections.push(cleanPrompt);
  }

  const inner = sanitizeBracketedPasteText(sections.join('\n\n'));
  return `${BRACKETED_PASTE_START}${inner}${BRACKETED_PASTE_END}`;
}

export function computePromptSubmitDelayMs(opts: {
  prompt: string;
  byteLength: number;
  agentId?: string | null;
  platform?: NodeJS.Platform;
}): number {
  const platform = opts.platform ?? process.platform;
  const bytesPerMs =
    platform === 'win32' ? WINDOWS_CONPTY_INGEST_BYTES_PER_MS : DEFAULT_PASTE_INGEST_BYTES_PER_MS;
  const ingestMs = opts.byteLength > 0 ? Math.ceil(opts.byteLength / bytesPerMs) : 0;
  const normalizedAgent = opts.agentId?.trim().toLowerCase() ?? '';
  const lineCount = Math.max(1, opts.prompt.split('\n').length);
  const lineSettleMs =
    normalizedAgent === 'antigravity' || normalizedAgent === 'agy'
      ? lineCount * ANTIGRAVITY_LINE_SETTLE_MS
      : 0;
  const inputRecordBurstMs =
    platform === 'win32' && normalizedAgent === 'codex'
      ? Math.min(opts.prompt.length * WINDOWS_INPUT_RECORD_PASTE_MS_PER_CHAR, MAX_WINDOWS_INPUT_RECORD_SETTLE_MS)
      : 0;
  return AGENT_PROMPT_SUBMIT_SETTLE_MS + ingestMs + Math.max(lineSettleMs, inputRecordBurstMs);
}

/**
 * Ported from Orca's `isHeldAgentPromptDraft`: checks whether the bottom composer region of the
 * terminal screen still holds an unsubmitted paste placeholder (`[Pasted Content N chars]`,
 * `[Pasted text #1 +N lines]`) or the trailing text of `prompt`, without an active working indicator.
 */
export function isHeldAgentPromptDraft(
  screenText: string | undefined,
  prompt: string,
  absorbedEnters = 1,
): boolean {
  if (!screenText || !prompt) return false;
  const lines = screenText
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;
  const tailWindow = lines.slice(-12).join('\n');
  if (/esc to interrupt/i.test(tailWindow)) {
    return false;
  }

  const cleanPrompt = sanitizeBracketedPasteText(prompt).trim();
  if (!cleanPrompt) return false;

  let pastedChars = 0;
  PASTED_CONTENT_PLACEHOLDER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PASTED_CONTENT_PLACEHOLDER_RE.exec(tailWindow)) !== null) {
    pastedChars += Number(match[1]);
  }
  if (pastedChars > 0) {
    const expectedChars = [...cleanPrompt].length;
    const lineFeeds = cleanPrompt.split('\n').length - 1;
    return (
      pastedChars >= Math.max(1, expectedChars - 16) &&
      pastedChars <= expectedChars + lineFeeds * 2 + absorbedEnters + 32
    );
  }

  if (INK_PASTED_LINES_PLACEHOLDER_RE.test(tailWindow)) {
    return true;
  }

  const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
  const collapsedPrompt = collapse(cleanPrompt);
  const lastComposerLine = collapse(lines.slice(-4).join(' '))
    .replace(/^[›>❯*•\s]+/, '')
    .trim();
  if (lastComposerLine.length >= 24 && collapsedPrompt.endsWith(lastComposerLine)) {
    return true;
  }
  return false;
}

export async function deliverPromptToPty(
  opts: DeliverPromptOptions,
  writeFn: PtyWriteFn,
): Promise<{ ok: true; bytesWritten: number } | { ok: false; error: string }> {
  const framed = formatAgentPromptPayload(opts);
  if (framed === `${BRACKETED_PASTE_START}${BRACKETED_PASTE_END}`) {
    return { ok: false, error: 'Prompt content is empty' };
  }

  const bytesWritten = Buffer.byteLength(framed, 'utf8');
  if (bytesWritten > PTY_INPUT_MAX_BYTES) {
    return {
      ok: false,
      error: `Prompt exceeds PTY input limit (${bytesWritten} > ${PTY_INPUT_MAX_BYTES} bytes)`,
    };
  }

  const pasteResult = await writeFn(opts.ptyId, framed);
  if (!pasteResult.ok) {
    return { ok: false, error: pasteResult.error ?? 'Terminal input failed' };
  }

  if (opts.submit) {
    const innerText = framed.slice(BRACKETED_PASTE_START.length, -BRACKETED_PASTE_END.length);
    const platform = opts.platform ?? process.platform;
    const bytesPerMs =
      platform === 'win32' ? WINDOWS_CONPTY_INGEST_BYTES_PER_MS : DEFAULT_PASTE_INGEST_BYTES_PER_MS;
    const fastBaseMs = 80 + Math.ceil(bytesWritten / bytesPerMs);

    if (opts.settleDelayMs !== undefined) {
      if (opts.settleDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, opts.settleDelayMs));
      }
    } else if (opts.getLastOutputAtMs) {
      // Wait for at least the transport ingest floor, then wait while the TUI is actively echoing
      // the paste burst (e.g. Win32 Codex INPUT_RECORD paste or Antigravity multiline expansion),
      // releasing as soon as output has been quiet for 350ms (up to Orca's per-agent budget).
      const maxBudgetMs = computePromptSubmitDelayMs({
        prompt: innerText,
        byteLength: bytesWritten,
        agentId: opts.agentId,
        platform,
      });
      const startedWait = Date.now();
      const baselineOutMs = opts.getLastOutputAtMs();
      await new Promise((resolve) => setTimeout(resolve, Math.min(fastBaseMs, maxBudgetMs)));
      while (Date.now() - startedWait < maxBudgetMs) {
        if (opts.isPaneAlive && !opts.isPaneAlive()) break;
        const lastOut = opts.getLastOutputAtMs();
        const sawEcho = lastOut > baselineOutMs;
        if (sawEcho && Date.now() - lastOut >= 350) break;
        if (!sawEcho && Date.now() - startedWait >= Math.min(450, maxBudgetMs)) break;
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, fastBaseMs));
    }

    if (opts.isPaneAlive && !opts.isPaneAlive()) {
      return { ok: false, error: 'Target pane exited during prompt delivery' };
    }
    const submitResult = await writeFn(opts.ptyId, '\r');
    if (!submitResult.ok) {
      return { ok: false, error: submitResult.error ?? 'Failed to submit prompt' };
    }

    const canRetryHeld =
      Boolean(opts.readScreen) && (opts.settleDelayMs === undefined || (opts.maxSubmitRetries ?? 0) > 0);
    if (canRetryHeld && opts.readScreen) {
      const maxRetries = opts.maxSubmitRetries ?? DEFAULT_MAX_HELD_SUBMIT_RETRIES;
      const retryDelayMs = opts.submitRetryDelayMs ?? DEFAULT_HELD_SUBMIT_RETRY_DELAY_MS;
      for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
        if (retryDelayMs > 0) {
          const stepMs = Math.min(100, retryDelayMs);
          const waitStart = Date.now();
          while (Date.now() - waitStart < retryDelayMs) {
            await new Promise((resolve) => setTimeout(resolve, stepMs));
            if (opts.isPaneAlive && !opts.isPaneAlive()) break;
            if (opts.hasTurnStartedOrBlocked?.()) break;
          }
        }
        if (opts.isPaneAlive && !opts.isPaneAlive()) break;
        if (opts.hasTurnStartedOrBlocked?.()) break;
        const screen = opts.readScreen();
        if (!isHeldAgentPromptDraft(screen, innerText, attempt)) {
          break;
        }
        const retryRes = await writeFn(opts.ptyId, '\r');
        if (!retryRes.ok) break;
      }
    }
  }

  return { ok: true, bytesWritten };
}
