import { PTY_INPUT_MAX_BYTES } from '../pty-input-limiter.js';

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
const DEFAULT_SUBMIT_SETTLE_DELAY_MS = 120;

// Strip ESC (0x1b), C1 CSI (0x9b), NUL, and control chars except TAB and LF.
// eslint-disable-next-line no-control-regex
const UNSAFE_PASTE_CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f\u009b]/g;

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
    const settleDelayMs = opts.settleDelayMs ?? DEFAULT_SUBMIT_SETTLE_DELAY_MS;
    if (settleDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, settleDelayMs));
    }
    const submitResult = await writeFn(opts.ptyId, '\r');
    if (!submitResult.ok) {
      return { ok: false, error: submitResult.error ?? 'Failed to submit prompt' };
    }
  }

  return { ok: true, bytesWritten };
}
