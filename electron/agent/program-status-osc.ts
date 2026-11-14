/**
 * Program Status Protocol (OSC 7501) parser, window title status classifier,
 * and stateful per-PTY escape sequence scanner.
 */

export const PROGRAM_STATUS_OSC_PREFIX = '\x1b]7501;';

export const PROGRAM_STATUS_STATES = ['idle', 'working', 'done', 'blocked', 'error'] as const;
export type ProgramStatusState = (typeof PROGRAM_STATUS_STATES)[number];

export const PROGRAM_STATUS_KINDS = ['permission', 'question', 'auth'] as const;
export type ProgramStatusKind = (typeof PROGRAM_STATUS_KINDS)[number];

export const PROGRAM_STATUS_QUERY_REPLY = `${PROGRAM_STATUS_OSC_PREFIX}?:states=${PROGRAM_STATUS_STATES.join(',')}:kinds=${PROGRAM_STATUS_KINDS.join(',')}\x1b\\`;

export const PROGRAM_STATUS_MAX_BODY_BYTES = 4087;

const MAX_KEY_BYTES = 16;
const MAX_MSG_ENCODED = 2732;
const MAX_MSG_DECODED = 2048;
const MAX_TITLE_ENCODED = 256;
const MAX_TITLE_DECODED = 192;
const MAX_ID_LENGTH = 128;
const MAX_ID_DEPTH = 8;
const MAX_APP_BYTES = 32;
const MAX_TITLE_BODY_LENGTH = 1024;
const MAX_PROMPT_START_OPTIONS_LENGTH = 512;

export interface ProgramStatusReport {
  id: string | null;
  state: ProgramStatusState | 'clear';
  kind?: ProgramStatusKind;
  progress?: number;
  app?: string;
  title?: string;
  msg?: string;
}

export type ProgramStatusMessage =
  | { type: 'query' }
  | { type: 'report'; report: ProgramStatusReport };

export type AgentPtyOscEvent =
  | { type: 'osc7501-query' }
  | { type: 'osc7501-report'; report: ProgramStatusReport }
  | { type: 'title'; title: string }
  | { type: 'prompt-start' }
  | { type: 'full-reset' };

const KEY_RE = /^[a-z]+$/;
const VALUE_RE = /^[A-Za-z0-9_.,+/=-]*$/;
const SEGMENT_RE = /^[A-Za-z0-9_.+-]{1,32}$/;
const APP_RE = /^[A-Za-z0-9_.+-]+$/;
const PROGRESS_RE = /^0*(\d{1,3})$/;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
// Reject decoded C0, DEL, and C1 control characters per the OSC 7501 spec.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export const APP_TO_AGENT_ID: Readonly<Record<string, string>> = {
  antigravity: 'antigravity',
  'antigravity-cli': 'antigravity',
  agy: 'antigravity',
  'claude-code': 'claude',
  'grok-build': 'grok',
  'kiro-cli': 'kiro',
  'qwen-code': 'qwen',
  qodercli: 'qoder',
};

export function normalizeAgentId(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  return Object.hasOwn(APP_TO_AGENT_ID, trimmed) ? APP_TO_AGENT_ID[trimmed]! : trimmed;
}

export function isProgramStatusState(value: unknown): value is ProgramStatusState {
  return PROGRAM_STATUS_STATES.some((s) => s === value);
}

export function isProgramStatusKind(value: unknown): value is ProgramStatusKind {
  return PROGRAM_STATUS_KINDS.some((k) => k === value);
}

function isValidId(id: string): boolean {
  if (!id || id.length > MAX_ID_LENGTH) return false;
  const segments = id.split('/');
  return (
    segments.length <= MAX_ID_DEPTH &&
    segments.every((seg) => seg !== '.' && seg !== '..' && SEGMENT_RE.test(seg))
  );
}

function decodeBase64Utf8(encoded: string, maxDecodedBytes: number): string | null {
  if (!BASE64_RE.test(encoded)) return null;
  const unpadded = encoded.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) return null;
  const padded = unpadded + '='.repeat((4 - (unpadded.length % 4)) % 4);
  const buf = Buffer.from(padded, 'base64');
  if (buf.length > maxDecodedBytes) return null;
  let text: string;
  try {
    text = utf8Decoder.decode(buf);
  } catch {
    return null;
  }
  return CONTROL_RE.test(text) ? null : text;
}

export function parseProgramStatusBody(body: string): ProgramStatusMessage | null {
  if (Buffer.byteLength(body, 'utf8') > PROGRAM_STATUS_MAX_BODY_BYTES) {
    return null;
  }
  if (body.trim() === '?') {
    return { type: 'query' };
  }

  const pairs = new Map<string, string>();
  const texts: Partial<Record<'msg' | 'title', string>> = {};

  for (const pair of body.split(':')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();

    if (
      Buffer.byteLength(key, 'utf8') > MAX_KEY_BYTES ||
      (key === 'app' && Buffer.byteLength(value, 'utf8') > MAX_APP_BYTES) ||
      (key === 'msg' && Buffer.byteLength(value, 'utf8') > MAX_MSG_ENCODED) ||
      (key === 'title' && Buffer.byteLength(value, 'utf8') > MAX_TITLE_ENCODED) ||
      (key === 'id' && !isValidId(value))
    ) {
      return null;
    }

    if (!KEY_RE.test(key) || !VALUE_RE.test(value)) {
      continue;
    }

    if (key === 'msg' || key === 'title') {
      const decoded = decodeBase64Utf8(
        value,
        key === 'msg' ? MAX_MSG_DECODED : MAX_TITLE_DECODED,
      );
      if (decoded === null) return null;
      texts[key] = decoded;
      continue;
    }

    pairs.set(key, value);
  }

  const state = pairs.get('state');
  if (state === undefined || (state !== 'clear' && !isProgramStatusState(state))) {
    return null;
  }

  const rawId = pairs.get('id');
  const report: ProgramStatusReport = { id: rawId ?? null, state };

  const kind = pairs.get('kind');
  if (state === 'blocked' && kind !== undefined && isProgramStatusKind(kind)) {
    report.kind = kind;
  }

  const progressMatch = PROGRESS_RE.exec(pairs.get('progress') ?? '');
  if ((state === 'working' || state === 'blocked') && progressMatch?.[1] !== undefined) {
    const progress = Number.parseInt(progressMatch[1], 10);
    if (progress <= 100) {
      report.progress = progress;
    }
  }

  const app = pairs.get('app');
  if (app !== undefined && APP_RE.test(app)) {
    report.app = normalizeAgentId(app) ?? app;
  }

  if (texts.msg) {
    report.msg = texts.msg;
  }
  if (texts.title) {
    report.title = texts.title;
  }

  return { type: 'report', report };
}

const BRAILLE_SPINNER_RE = /[\u2800-\u28ff]/;
const QUARTER_CIRCLE_SPINNER_RE = /[\u25d0-\u25d3]/;
const WAITING_KEYWORDS_RE = /(^|[^\w./\\-])(action required|permission|waiting)(?![\w-])/i;
const WORKING_KEYWORDS_RE = /(^|[^\w./\\-])(working|thinking|running)(?![\w-])/i;
const IDLE_KEYWORDS_RE = /(^|[^\w./\\-])(ready|idle|done)(?![\w-])/i;
const LEADING_STATUS_GLYPH_RE = /^[\s\u2800-\u28ff\u25d0-\u25d3\u270b\u2726\u23f2\u2733\u25c7]+/;

export function classifyAgentTitleStatus(
  title: string,
): { state: 'working' | 'waiting' | 'idle'; waitKind?: ProgramStatusKind; cleanTitle: string } | null {
  const cleanTitle = title.replace(LEADING_STATUS_GLYPH_RE, '').trim();

  if (title.includes('\u270b') || WAITING_KEYWORDS_RE.test(title)) {
    return { state: 'waiting', waitKind: 'permission', cleanTitle };
  }

  if (
    title.includes('\u2726') ||
    title.includes('\u23f2') ||
    BRAILLE_SPINNER_RE.test(title) ||
    QUARTER_CIRCLE_SPINNER_RE.test(title) ||
    WORKING_KEYWORDS_RE.test(title)
  ) {
    return { state: 'working', cleanTitle };
  }

  if (title.includes('\u2733') || title.includes('\u25c7') || IDLE_KEYWORDS_RE.test(title)) {
    return { state: 'idle', cleanTitle };
  }

  return null;
}

const OSC_TITLE_0_PREFIX = '\x1b]0;';
const OSC_TITLE_2_PREFIX = '\x1b]2;';
const PROMPT_START_MARKER = '\x1b]133;A';
const FULL_RESET_MARKER = '\x1bc';

const MARKERS = [
  PROGRAM_STATUS_OSC_PREFIX,
  OSC_TITLE_0_PREFIX,
  OSC_TITLE_2_PREFIX,
  PROMPT_START_MARKER,
  FULL_RESET_MARKER,
] as const;

const LONGEST_MARKER_LEN = Math.max(...MARKERS.map((m) => m.length));

function markerPrefixCarry(data: string): string {
  const lastEsc = data.lastIndexOf('\x1b');
  if (lastEsc === -1 || data.length - lastEsc >= LONGEST_MARKER_LEN) {
    return '';
  }
  const suffix = data.slice(lastEsc);
  return MARKERS.some((marker) => marker.length > suffix.length && marker.startsWith(suffix))
    ? suffix
    : '';
}

interface OscFrameEnd {
  index: number;
  length: number;
  aborted?: true;
}

function findOscTerminator(data: string, from: number, limit: number): OscFrameEnd | null {
  const end = Math.min(limit, data.length);
  for (let i = from; i < end; i++) {
    const code = data.charCodeAt(i);
    if (code === 0x07) {
      return { index: i, length: 1 };
    }
    if (code === 0x18 || code === 0x1a) {
      return { index: i, length: 1, aborted: true };
    }
    if (code === 0x1b && i + 1 < data.length) {
      return { index: i, length: data.charCodeAt(i + 1) === 0x5c ? 2 : 0 };
    }
  }
  return null;
}

export function createAgentPtyOscScanner(): (data: string) => AgentPtyOscEvent[] {
  let pending = '';

  return (data: string): AgentPtyOscEvent[] => {
    if (!data) return [];
    if (pending.length === 0 && !data.includes('\x1b')) {
      return [];
    }
    if (
      pending.length === 0 &&
      !data.includes(PROGRAM_STATUS_OSC_PREFIX) &&
      !data.includes(OSC_TITLE_0_PREFIX) &&
      !data.includes(OSC_TITLE_2_PREFIX) &&
      !data.includes(PROMPT_START_MARKER) &&
      !data.includes(FULL_RESET_MARKER)
    ) {
      pending = markerPrefixCarry(data);
      return [];
    }

    const combined = pending + data;
    pending = '';
    const events: AgentPtyOscEvent[] = [];
    let cursor = 0;

    while (cursor < combined.length) {
      const esc = combined.indexOf('\x1b', cursor);
      if (esc === -1) break;

      if (combined.startsWith(FULL_RESET_MARKER, esc)) {
        cursor = esc + FULL_RESET_MARKER.length;
        events.push({ type: 'full-reset' });
        continue;
      }

      if (combined.startsWith(PROMPT_START_MARKER, esc)) {
        const afterMark = esc + PROMPT_START_MARKER.length;
        const next = combined.charCodeAt(afterMark);
        // Only treat `;A` followed by BEL, ESC, `;` options, or end-of-chunk as prompt-start.
        const isPromptStart = next === 0x07 || next === 0x1b || next === 0x3b;
        const term = isPromptStart
          ? findOscTerminator(combined, afterMark, afterMark + MAX_PROMPT_START_OPTIONS_LENGTH)
          : null;
        if (term !== null) {
          cursor = term.index + term.length;
          if (!term.aborted) {
            events.push({ type: 'prompt-start' });
          }
          continue;
        }
        if (
          (Number.isNaN(next) || isPromptStart) &&
          combined.length - afterMark < MAX_PROMPT_START_OPTIONS_LENGTH
        ) {
          pending = combined.slice(esc);
          break;
        }
        cursor = afterMark;
        continue;
      }

      if (combined.startsWith(PROGRAM_STATUS_OSC_PREFIX, esc)) {
        const bodyStart = esc + PROGRAM_STATUS_OSC_PREFIX.length;
        const term = findOscTerminator(
          combined,
          bodyStart,
          bodyStart + PROGRAM_STATUS_MAX_BODY_BYTES + 1,
        );
        if (term === null) {
          const retainable = PROGRAM_STATUS_MAX_BODY_BYTES + (combined.endsWith('\x1b') ? 1 : 0);
          if (combined.length - bodyStart <= retainable) {
            pending = combined.slice(esc);
            break;
          }
          cursor = bodyStart;
          continue;
        }
        cursor = term.index + term.length;
        if (!term.aborted) {
          const msg = parseProgramStatusBody(combined.slice(bodyStart, term.index));
          if (msg?.type === 'query') {
            events.push({ type: 'osc7501-query' });
          } else if (msg?.type === 'report') {
            events.push({ type: 'osc7501-report', report: msg.report });
          }
        }
        continue;
      }

      const titlePrefix = combined.startsWith(OSC_TITLE_0_PREFIX, esc)
        ? OSC_TITLE_0_PREFIX
        : combined.startsWith(OSC_TITLE_2_PREFIX, esc)
          ? OSC_TITLE_2_PREFIX
          : null;
      if (titlePrefix) {
        const bodyStart = esc + titlePrefix.length;
        const term = findOscTerminator(combined, bodyStart, bodyStart + MAX_TITLE_BODY_LENGTH + 1);
        if (term === null) {
          const retainable = MAX_TITLE_BODY_LENGTH + (combined.endsWith('\x1b') ? 1 : 0);
          if (combined.length - bodyStart <= retainable) {
            pending = combined.slice(esc);
            break;
          }
          cursor = bodyStart;
          continue;
        }
        cursor = term.index + term.length;
        if (!term.aborted) {
          events.push({ type: 'title', title: combined.slice(bodyStart, term.index) });
        }
        continue;
      }

      if (combined.length - esc < LONGEST_MARKER_LEN) {
        const carry = markerPrefixCarry(combined.slice(esc));
        if (carry.length > 0) {
          pending = carry;
          break;
        }
      }
      cursor = esc + 1;
    }

    return events;
  };
}
