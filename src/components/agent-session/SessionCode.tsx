// Code block language labels, line-wrap toggle, and plain muted mode adapted from Orca
// (https://github.com/stablyai/orca, NativeChatCodeBlock.tsx). Copyright (c) 2026 Lovecast Inc. — MIT License.
// See THIRD_PARTY_NOTICES.md.

import { Fragment, memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, Copy, WrapText } from 'lucide-react';
import type { BundledLanguage } from 'shiki/langs';
import { useCodeHighlight } from '../../hooks/useCodeHighlight';
import { detectCodeLanguage } from '../../lib/code-language';
import type { CodeHighlightAppearance, DiffHighlightRow, SyntaxToken } from '../../lib/code-syntax-highlight';
import { requestCodeHighlight } from '../../lib/code-syntax-highlight-client';
import { parseUnifiedDiff, type DiffLine } from '../../lib/git-panel-model';
import { codeFenceLanguageLabel } from '../../lib/session-work-log-model';
import { fenceLanguage } from '../../lib/worker-timeline-model';
import { renderLineTokens } from '../SyntaxTokens';
import { useAgentSession } from './session-context';
import { useSessionDisclosure } from './session-disclosure-store';

const MAX_DIFF_ROWS = 2000;
const HIGHLIGHT_DEBOUNCE_MS = 120;

const useAppearance = (): CodeHighlightAppearance => useAgentSession().appearance;

export function CopyButton({ text, label = '复制', className = 'asv-copy' }: { text: string; label?: string; className?: string }) {
  const { onNotify } = useAgentSession();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    const write = navigator.clipboard?.writeText(text);
    if (!write) {
      onNotify?.('当前环境无法复制');
      return;
    }
    void write.then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1400);
    }, () => onNotify?.('复制失败'));
  };
  return (
    <button
      type="button"
      className={className}
      data-copied={copied || undefined}
      onClick={copy}
      aria-label={copied ? '已复制' : label}
      title={copied ? '已复制' : label}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

interface LineTokens {
  lines: readonly string[];
  lang: string;
  appearance: CodeHighlightAppearance;
  tokens: Array<SyntaxToken[] | null>;
}

/**
 * A streaming code block changes on every patch. Requests are debounced, and the last result
 * keeps colouring every line whose text is unchanged, so the block never flashes back to plain.
 */
function useStreamingLineTokens(lines: readonly string[], lang: string | null, appearance: CodeHighlightAppearance) {
  const consumer = useId();
  const [result, setResult] = useState<LineTokens | null>(null);
  useEffect(() => {
    if (!lang || lines.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void requestCodeHighlight(consumer, { kind: 'code', lines }, lang as BundledLanguage, appearance).then((tokens) => {
        if (!cancelled && tokens) setResult({ lines, lang, appearance, tokens });
      });
    }, HIGHLIGHT_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [consumer, lines, lang, appearance]);
  if (!result || result.lang !== lang || result.appearance !== appearance) return null;
  return result;
}

export const CodeBlock = memo(function CodeBlock({
  info,
  code,
  disclosureKey,
  plain = false,
}: {
  info: string;
  code: string;
  disclosureKey?: string;
  /** Suppress syntax tokenization for muted reasoning blocks so code inherits faint tone. */
  plain?: boolean;
}) {
  const appearance = useAppearance();
  const lines = useMemo(() => code.split('\n'), [code]);
  const lang = plain ? null : fenceLanguage(info);
  const highlighted = useStreamingLineTokens(lines, lang, appearance);
  const rawTag = info.trim().split(/\s+/)[0] ?? '';
  const displayLabel = codeFenceLanguageLabel(rawTag);
  const { open: wrapped, setOpen: setWrapped } = useSessionDisclosure(disclosureKey, false);
  const wrapLabel = wrapped ? '取消自动换行' : '自动换行';

  return (
    <div className="asv-code" data-lang={rawTag || undefined} data-wrapped={wrapped || undefined}>
      <div className="asv-code-head">
        <span className="asv-code-lang" title={rawTag || undefined}>{displayLabel}</span>
        <span className="asv-code-actions">
          <button
            type="button"
            className="asv-code-btn"
            aria-pressed={wrapped}
            aria-label={wrapLabel}
            title={wrapLabel}
            onClick={() => setWrapped(!wrapped)}
          >
            <WrapText size={13} />
          </button>
          <CopyButton text={code} label="复制代码" />
        </span>
      </div>
      <pre>
        <code>
          {lines.map((line, i) => {
            const tokens = highlighted && highlighted.lines[i] === line ? highlighted.tokens[i] : null;
            return <Fragment key={i}>{tokens?.length ? renderLineTokens(tokens) : line}{'\n'}</Fragment>;
          })}
        </code>
      </pre>
    </div>
  );
});

/** Providers send whole-file text for adds and deletes; present it as one hunk of that kind. */
function rowsFromRawContent(content: string, change: 'add' | 'delete' | 'update'): DiffLine[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((text, i) =>
    change === 'add'
      ? { kind: 'add', text, oldLine: null, newLine: i + 1 }
      : change === 'delete'
        ? { kind: 'del', text, oldLine: i + 1, newLine: null }
        : { kind: 'context', text, oldLine: i + 1, newLine: i + 1 });
}

const SIGN: Partial<Record<DiffLine['kind'], string>> = { add: '+', del: '-' };

export const DiffBlock = memo(function DiffBlock({
  diff,
  path,
  change = 'update',
}: {
  diff: string;
  path?: string;
  change?: 'add' | 'delete' | 'update';
}) {
  const appearance = useAppearance();
  const { rows, total } = useMemo(() => {
    const parsed = parseUnifiedDiff(diff);
    const body = parsed.some((row) => row.kind === 'hunk')
      ? parsed.filter((row) => row.kind !== 'file' && row.kind !== 'meta')
      : rowsFromRawContent(diff, change);
    return { rows: body.slice(0, MAX_DIFF_ROWS), total: body.length };
  }, [diff, change]);
  const lang = useMemo(() => (path ? detectCodeLanguage(path) : null), [path]);
  const tokens = useCodeHighlight('diff', rows as readonly DiffHighlightRow[], lang, appearance);
  if (rows.length === 0) return <div className="asv-detail-note">没有可显示的差异</div>;
  return (
    <div className="asv-diff" role="table" aria-label={path ? `${path} 的差异` : '差异'}>
      {rows.map((row, i) =>
        row.kind === 'hunk' ? (
          <div key={i} className="asv-diff-row is-hunk" role="row">
            <span className="asv-diff-hunk">{row.text}</span>
          </div>
        ) : (
          <div key={i} className={`asv-diff-row is-${row.kind}`} role="row">
            <span className="asv-diff-num">{row.oldLine ?? ''}</span>
            <span className="asv-diff-num">{row.newLine ?? ''}</span>
            <span className="asv-diff-sign">{SIGN[row.kind] ?? ' '}</span>
            <span className="asv-diff-text">{tokens?.[i]?.length ? renderLineTokens(tokens[i]!) : row.text || ' '}</span>
          </div>
        ),
      )}
      {total > rows.length && <div className="asv-detail-note">差异较长，仅显示前 {rows.length} 行</div>}
    </div>
  );
});
