import type { ILink, ILinkProvider, IBufferRange, Terminal } from '@xterm/xterm';
import type { TerminalSession } from '../terminal-session';
import type { TerminalLinkBuffer } from '../shared/terminal/links/terminal-link-buffer';
import { buildTerminalHttpLogicalLines, hasHardWrappedRows } from '../shared/terminal/links/terminal-http-logical-lines';
import { extractTerminalHttpLinks } from '../shared/terminal/links/terminal-http-url-extraction';
import { rangeForParsedLinkOnRow } from '../shared/terminal/links/terminal-link-row-range';
import { terminalLogicalLinkHasOscLink } from '../shared/terminal/links/terminal-osc-link-cells';
import {
  buildCandidateLogicalLinesForBufferPosition,
  findTerminalHttpLinkAtBufferPosition,
} from '../shared/terminal/links/terminal-link-buffer-hit-testing';
import { extractTerminalFileLinkReadings } from '../shared/terminal/links/terminal-links';
import { rangeForParsedFileLink } from '../shared/terminal/links/wrapped-terminal-link-ranges';
import {
  isSafeTerminalLinkCandidate,
  resolveSafeOscLinkTarget,
} from './terminal-link-safety';
import { orchestrationClient } from '../orchestration-client';
import {
  dispatchFocusOrchestrationTarget,
  extractOrchestrationTerminalLinks,
  resolveOrchestrationLinkTarget,
} from './orchestration-terminal-links';

export interface RegisterTerminalLinksOptions {
  getCwd: () => string | undefined;
  onNotify?: (message: string) => void;
}

interface PathCacheEntry {
  exists: boolean;
  expiresAt: number;
}

const PATH_CACHE_TTL_MS = 5000;
const PATH_CACHE_MAX_ENTRIES = 500;
const MAX_CHECK_PATHS_BATCH = 200;

function isIntentionalLinkClick(event: MouseEvent | undefined): boolean {
  if (!event) return false;
  if (event.button !== undefined && event.button !== 0) return false;
  return Boolean(event.ctrlKey || event.metaKey);
}

function formatActivationHint(targetLabel: string): string {
  const isMac =
    typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);
  return `${isMac ? 'Cmd' : 'Ctrl'} + 单击打开 ${targetLabel}`;
}

function toXtermRange(range: { start: { x: number; y: number }; end: { x: number; y: number } }): IBufferRange {
  return {
    start: { x: range.start.x, y: range.start.y },
    end: { x: range.end.x, y: range.end.y },
  };
}

function rangeKey(range: IBufferRange, suffix: string): string {
  return `${range.start.y}:${range.start.x}-${range.end.y}:${range.end.x}:${suffix}`;
}

export function registerTerminalLinks(
  session: TerminalSession,
  options: RegisterTerminalLinksOptions,
): () => void {
  const terminal: Terminal = session.terminal;
  const pathCache = new Map<string, PathCacheEntry>();
  let hoverTooltip: HTMLDivElement | null = null;

  const hideTooltip = () => {
    hoverTooltip?.remove();
    hoverTooltip = null;
  };

  const showTooltip = (event: MouseEvent, label: string) => {
    const container = terminal.element;
    if (!container) return;
    if (!hoverTooltip) {
      hoverTooltip = document.createElement('div');
      hoverTooltip.className = 'terminal-link-tooltip xterm-hover';
      container.appendChild(hoverTooltip);
    }
    hoverTooltip.textContent = formatActivationHint(label);
    const rect = container.getBoundingClientRect();
    const relX = Math.max(8, Math.min(rect.width - 220, event.clientX - rect.left + 8));
    const relY = Math.max(8, event.clientY - rect.top - 28);
    hoverTooltip.style.left = `${relX}px`;
    hoverTooltip.style.top = `${relY}px`;
  };

  const openTarget = async (target: string, cwdOverride?: string) => {
    const api = typeof window !== 'undefined' ? window.vibeMeet?.shellPty?.openLink : undefined;
    if (!api) return;
    try {
      const res = await api({ target, cwd: cwdOverride ?? options.getCwd() });
      if (!res.ok) {
        options.onNotify?.(res.error || `无法打开：${target}`);
      } else if (res.action === 'revealed') {
        options.onNotify?.(`已在文件管理器中定位：${res.path ?? target}`);
      }
    } catch (error) {
      options.onNotify?.(`打开链接失败：${String(error)}`);
    }
  };

  const checkPathsExist = async (cwd: string | undefined, candidates: string[]): Promise<Set<string>> => {
    const unique = Array.from(new Set(candidates)).slice(0, MAX_CHECK_PATHS_BATCH);
    const now = Date.now();
    const result = new Set<string>();
    const pending: string[] = [];

    for (const p of unique) {
      const key = `${cwd ?? ''}::${p}`;
      const cached = pathCache.get(key);
      if (cached && cached.expiresAt > now) {
        if (cached.exists) result.add(p);
      } else {
        pending.push(p);
      }
    }

    if (pending.length > 0) {
      const api = typeof window !== 'undefined' ? window.vibeMeet?.shellPty?.checkPaths : undefined;
      if (api) {
        try {
          const res = await api({ cwd, paths: pending });
          if (res.ok) {
            if (pathCache.size + pending.length > PATH_CACHE_MAX_ENTRIES) {
              pathCache.clear();
            }
            const expiresAt = Date.now() + PATH_CACHE_TTL_MS;
            for (const p of pending) {
              const exists = Boolean(res.existing[p]);
              pathCache.set(`${cwd ?? ''}::${p}`, { exists, expiresAt });
              if (exists) result.add(p);
            }
          }
        } catch {
          // Ignore check failure silently so terminal rendering stays unaffected.
        }
      }
    }

    return result;
  };

  // 1. Wrapped HTTP/HTTPS URL link provider
  const httpProvider: ILinkProvider = {
    provideLinks(bufferLineNumber, callback) {
      const buffer = terminal.buffer.active as unknown as TerminalLinkBuffer;
      const logicalLines = buildTerminalHttpLogicalLines(buffer, bufferLineNumber);
      const links: ILink[] = [];
      const seen = new Set<string>();

      for (const logicalLine of logicalLines) {
        for (const parsed of extractTerminalHttpLinks(logicalLine.text)) {
          const fullRange = rangeForParsedFileLink(logicalLine, parsed.startIndex, parsed.endIndex);
          const rowRange = rangeForParsedLinkOnRow(
            logicalLine,
            parsed.startIndex,
            parsed.endIndex,
            bufferLineNumber,
          );
          if (
            !fullRange ||
            !rowRange ||
            (hasHardWrappedRows(logicalLine) && fullRange.start.y === fullRange.end.y) ||
            terminalLogicalLinkHasOscLink(buffer, logicalLine, parsed.startIndex, parsed.endIndex)
          ) {
            continue;
          }
          const range = toXtermRange(rowRange);
          const key = rangeKey(range, parsed.url);
          if (seen.has(key)) continue;
          seen.add(key);

          links.push({
            range,
            text: parsed.url,
            decorations: { pointerCursor: true, underline: true },
            hover: (ev) => showTooltip(ev, parsed.url),
            leave: hideTooltip,
            activate: (event) => {
              if (!isIntentionalLinkClick(event)) return;
              event.preventDefault();
              hideTooltip();
              // Re-check buffer position so wrapped multi-line URLs always open the full joined URL.
              const joined =
                findTerminalHttpLinkAtBufferPosition(
                  terminal.buffer.active as unknown as TerminalLinkBuffer,
                  { x: rowRange.start.x, y: bufferLineNumber },
                  terminal.cols,
                ) ?? parsed.url;
              void openTarget(joined);
            },
          });
        }
      }
      callback(links.length > 0 ? links : undefined);
    },
  };

  // 2. Local file path & path:line:col link provider (verified against filesystem)
  const fileProvider: ILinkProvider = {
    provideLinks(bufferLineNumber, callback) {
      const buffer = terminal.buffer.active as unknown as TerminalLinkBuffer;
      const logicalLines = buildCandidateLogicalLinesForBufferPosition(buffer, bufferLineNumber);
      const cwd = options.getCwd();
      const candidates: Array<{
        pathText: string;
        displayText: string;
        rowRange: NonNullable<ReturnType<typeof rangeForParsedLinkOnRow>>;
      }> = [];
      const pathInputs: string[] = [];

      for (const logicalLine of logicalLines) {
        const readings = extractTerminalFileLinkReadings(logicalLine.text);
        for (const parsed of [...readings.links, ...readings.guesses]) {
          if (!isSafeTerminalLinkCandidate(parsed.pathText, cwd)) {
            continue;
          }
          const rowRange = rangeForParsedLinkOnRow(
            logicalLine,
            parsed.startIndex,
            parsed.endIndex,
            bufferLineNumber,
          );
          if (
            !rowRange ||
            terminalLogicalLinkHasOscLink(buffer, logicalLine, parsed.startIndex, parsed.endIndex)
          ) {
            continue;
          }
          candidates.push({
            pathText: parsed.pathText,
            displayText: parsed.displayText,
            rowRange,
          });
          pathInputs.push(parsed.pathText);
        }
      }

      if (candidates.length === 0) {
        callback(undefined);
        return;
      }

      void checkPathsExist(cwd, pathInputs).then((existing) => {
        const links: ILink[] = [];
        const seen = new Set<string>();
        for (const item of candidates) {
          if (!existing.has(item.pathText)) continue;
          const range = toXtermRange(item.rowRange);
          const key = rangeKey(range, item.pathText);
          if (seen.has(key)) continue;
          seen.add(key);

          links.push({
            range,
            text: item.displayText,
            decorations: { pointerCursor: true, underline: true },
            hover: (ev) => showTooltip(ev, item.displayText),
            leave: hideTooltip,
            activate: (event) => {
              if (!isIntentionalLinkClick(event)) return;
              event.preventDefault();
              hideTooltip();
              void openTarget(item.pathText, cwd);
            },
          });
        }
        callback(links.length > 0 ? links : undefined);
      });
    },
  };

  // 3. OSC 8 explicit terminal hyperlinks (never allow UNC/device paths or remote file:// authorities)
  const previousLinkHandler = terminal.options.linkHandler;
  const isWinHost =
    typeof navigator !== 'undefined' && /win/i.test(navigator.platform || navigator.userAgent);
  terminal.options.linkHandler = {
    activate(event, text) {
      if (!isIntentionalLinkClick(event)) return;
      event.preventDefault();
      hideTooltip();
      const cwd = options.getCwd();
      const target = resolveSafeOscLinkTarget(text, cwd, isWinHost);
      if (!target) {
        options.onNotify?.(`已拦截不支持或不安全的链接目标：${text}`);
        return;
      }
      if (target.kind === 'url') {
        void openTarget(target.url);
      } else if (target.kind === 'file-url') {
        void openTarget(target.target.filePath, cwd);
      } else {
        void openTarget(target.link.pathText, cwd);
      }
    },
    hover(event, text) {
      showTooltip(event, text);
    },
    leave() {
      hideTooltip();
    },
    allowNonHttpProtocols: true,
  };

  // 4. Orchestration #task_xxx / ctx_xxx / @handle link provider
  const orchestrationProvider: ILinkProvider = {
    provideLinks(bufferLineNumber, callback) {
      const buffer = terminal.buffer.active as unknown as TerminalLinkBuffer;
      const logicalLines = buildCandidateLogicalLinesForBufferPosition(buffer, bufferLineNumber);
      const snapshot = orchestrationClient.getSnapshot();
      const links: ILink[] = [];
      const seen = new Set<string>();

      for (const logicalLine of logicalLines) {
        const tokens = extractOrchestrationTerminalLinks(logicalLine.text);
        for (const token of tokens) {
          const resolved = resolveOrchestrationLinkTarget(token, snapshot, session.getPtyId());
          if (!resolved) continue;
          const rowRange = rangeForParsedLinkOnRow(
            logicalLine,
            token.startIndex,
            token.endIndex,
            bufferLineNumber,
          );
          if (
            !rowRange ||
            terminalLogicalLinkHasOscLink(buffer, logicalLine, token.startIndex, token.endIndex)
          ) {
            continue;
          }
          const range = toXtermRange(rowRange);
          const key = rangeKey(range, token.rawText);
          if (seen.has(key)) continue;
          seen.add(key);

          links.push({
            range,
            text: token.rawText,
            decorations: { pointerCursor: true, underline: true },
            hover: (ev) => showTooltip(ev, resolved.label),
            leave: hideTooltip,
            activate: (event) => {
              if (!isIntentionalLinkClick(event)) return;
              event.preventDefault();
              hideTooltip();
              const latestResolved =
                resolveOrchestrationLinkTarget(token, orchestrationClient.getSnapshot(), session.getPtyId());
              if (!latestResolved) return;
              if (latestResolved.ptyId) {
                dispatchFocusOrchestrationTarget(latestResolved);
              } else {
                options.onNotify?.(`${latestResolved.label} 当前没有活跃终端`);
              }
            },
          });
        }
      }
      callback(links.length > 0 ? links : undefined);
    },
  };

  const disposeHttp = session.registerLinkProvider(httpProvider);
  const disposeFile = session.registerLinkProvider(fileProvider);
  const disposeOrchestration = session.registerLinkProvider(orchestrationProvider);

  return () => {
    hideTooltip();
    disposeHttp.dispose();
    disposeFile.dispose();
    disposeOrchestration.dispose();
    if (terminal.options.linkHandler) {
      terminal.options.linkHandler = previousLinkHandler ?? undefined;
    }
  };
}
