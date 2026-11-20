import { Fragment, useEffect, useId, useMemo, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Bot, ClipboardPaste, FileDiff, FileText, LoaderCircle, RefreshCw, Send, X } from 'lucide-react';
import type { BundledLanguage } from 'shiki/langs';
import {
  agentStatusLabel,
  buildDiffSnippet,
  fitPromptParts,
  isAgentStatusVisible,
  relativeFromDir,
} from '../lib/agent-status-view';
import { detectCodeLanguage } from '../lib/code-language';
import {
  requestCodeHighlight,
  type CodeHighlightSource,
  type CodeHighlightTokens,
} from '../lib/code-syntax-highlight-client';
import type {
  CodeHighlightAppearance,
  DiffHighlightRow,
  SyntaxToken,
} from '../lib/code-syntax-highlight';
import { terminalSessionStore } from '../lib/terminal-session-store';
import {
  countDiffStats,
  formatFileSize,
  joinHostPath,
  parseUnifiedDiff,
  splitRepoPath,
  type GitChangeGroupId,
} from '../lib/git-panel-model';
import type { AgentPaneStatus, GitDiffResult, WorkspaceFsReadFileResult } from '../types';

export type PanelPreviewTarget =
  | { kind: 'diff'; cwd: string; path: string; staged: boolean; group: GitChangeGroupId }
  | { kind: 'file'; rootPath: string; relativePath: string };

export interface AgentPromptTarget {
  ptyId: string;
  windowId: string;
  leafId: string;
  label: string;
  cwd?: string;
  cliId?: string;
  /** Launched as an agent CLI rather than a plain shell. */
  isAgent: boolean;
  isActive: boolean;
  status: AgentPaneStatus | null;
}

interface LineSelection {
  anchor: number;
  focus: number;
}

interface PromptContext {
  relativePath: string;
  startLine?: number;
  endLine?: number;
  diffSnippet?: string;
  summary: string;
}

const MAX_DIFF_ROWS = 4000;
const MAX_FILE_LINES = 6000;
const CODE_LINE_HEIGHT = 18;

function useCodeLanguage(filePath: string): BundledLanguage | null {
  return useMemo(() => detectCodeLanguage(filePath), [filePath]);
}

interface CodeHighlightResult {
  kind: 'code' | 'diff';
  content: readonly string[] | readonly DiffHighlightRow[];
  lang: BundledLanguage;
  appearance: CodeHighlightAppearance;
  tokens: CodeHighlightTokens;
}

function useCodeHighlight(
  kind: 'code' | 'diff',
  content: readonly string[] | readonly DiffHighlightRow[],
  lang: BundledLanguage | null,
  appearance: CodeHighlightAppearance,
): CodeHighlightTokens {
  const consumer = useId();
  const [result, setResult] = useState<CodeHighlightResult | null>(null);

  useEffect(() => {
    if (!lang || content.length === 0) return;
    let cancelled = false;
    const source: CodeHighlightSource = kind === 'code'
      ? { kind, lines: content as readonly string[] }
      : { kind, rows: content as readonly DiffHighlightRow[] };
    void requestCodeHighlight(consumer, source, lang, appearance).then((tokens) => {
      if (!cancelled) setResult({ kind, content, lang, appearance, tokens });
    });
    return () => {
      cancelled = true;
    };
  }, [consumer, kind, content, lang, appearance]);

  if (
    !lang ||
    result?.kind !== kind ||
    result.content !== content ||
    result.lang !== lang ||
    result.appearance !== appearance
  ) {
    return null;
  }
  return result.tokens;
}

function renderLineTokens(tokens: readonly SyntaxToken[]): ReactNode {
  if (tokens.length === 0) return null;
  return tokens.map((tok, i) =>
    tok.color || tok.italic ? (
      <span
        key={i}
        style={
          tok.color && tok.italic
            ? { color: tok.color, fontStyle: 'italic' }
            : tok.color
              ? { color: tok.color }
              : { fontStyle: 'italic' }
        }
      >
        {tok.text}
      </span>
    ) : (
      tok.text
    )
  );
}

export function previewKey(target: PanelPreviewTarget | null): string {
  if (!target) return '';
  return target.kind === 'diff'
    ? `diff:${target.staged ? 's' : 'w'}:${target.path}`
    : `file:${target.relativePath}`;
}

const lineRangeText = (start?: number, end?: number) =>
  start === undefined ? '' : end !== undefined && end !== start ? `第 ${start}–${end} 行` : `第 ${start} 行`;

function nextSelection(prev: LineSelection | null, index: number, extend: boolean): LineSelection | null {
  if (extend && prev) return { anchor: prev.anchor, focus: index };
  if (prev && prev.anchor === index && prev.focus === index) return null;
  return { anchor: index, focus: index };
}

export function PanelPreview({
  target,
  rootPath,
  refreshToken,
  headerExtra,
  agentTargets,
  onAgentPromptSent,
  onClose,
}: {
  target: PanelPreviewTarget;
  /** Absolute root the target's relative path is resolved against. */
  rootPath: string;
  /** Changes whenever the surrounding status refreshes, so content is refetched. */
  refreshToken: number;
  headerExtra?: ReactNode;
  agentTargets: AgentPromptTarget[];
  onAgentPromptSent: (target: AgentPromptTarget) => void;
  onClose: () => void;
}) {
  const [manualToken, setManualToken] = useState(0);
  const [selection, setSelection] = useState<LineSelection | null>(null);
  const [context, setContext] = useState<PromptContext | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const title = target.kind === 'diff' ? target.path : target.relativePath;
  const { name, dir } = splitRepoPath(title);
  const token = `${refreshToken}:${manualToken}`;
  const selectLine = (index: number, extend: boolean) => {
    setSelection((prev) => nextSelection(prev, index, extend));
    setComposerOpen(true);
  };
  return (
    <section className="wrp-preview" aria-label={`预览 ${title}`}>
      <header className="wrp-preview-header">
        {target.kind === 'diff' ? <FileDiff size={14} /> : <FileText size={14} />}
        <span className="wrp-preview-title" title={title}>
          <strong>{name}</strong>
          {dir && <small>{dir}</small>}
        </span>
        {target.kind === 'diff' && (
          <span className="wrp-chip">{target.staged ? '已暂存' : target.group === 'untracked' ? '新文件' : '工作区'}</span>
        )}
        <button
          type="button"
          className={composerOpen ? 'is-active' : ''}
          title="发送到 Agent（点击行号选择行，Shift+点击扩展选择）"
          aria-label="发送到 Agent"
          aria-expanded={composerOpen}
          onClick={() => setComposerOpen((v) => !v)}
        >
          <Bot size={13} />
        </button>
        {headerExtra}
        <button type="button" title="刷新预览" aria-label="刷新预览" onClick={() => setManualToken((v) => v + 1)}>
          <RefreshCw size={13} />
        </button>
        <button type="button" title="关闭预览" aria-label="关闭预览" onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      {target.kind === 'diff' ? (
        <DiffBody target={target} token={token} selection={selection} onSelectLine={selectLine} onContext={setContext} />
      ) : (
        <FileBody target={target} token={token} selection={selection} onSelectLine={selectLine} onContext={setContext} />
      )}
      {composerOpen && (
        <AgentComposer
          rootPath={rootPath}
          context={context}
          hasSelection={Boolean(selection)}
          onClearSelection={() => setSelection(null)}
          targets={agentTargets}
          onSent={(sentTo) => {
            setSelection(null);
            onAgentPromptSent(sentTo);
          }}
          onClose={() => setComposerOpen(false)}
        />
      )}
    </section>
  );
}

function DiffBody({
  target,
  token,
  selection,
  onSelectLine,
  onContext,
}: {
  target: Extract<PanelPreviewTarget, { kind: 'diff' }>;
  token: string;
  selection: LineSelection | null;
  onSelectLine: (index: number, extend: boolean) => void;
  onContext: (context: PromptContext | null) => void;
}) {
  const [result, setResult] = useState<GitDiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const { cwd, path, staged } = target;

  useEffect(() => {
    setResult(null);
  }, [cwd, path, staged]);

  useEffect(() => {
    let cancelled = false;
    const api = window.vibeMeet.git;
    if (!api) {
      setResult({ ok: false, error: 'Git 接口不可用' });
      return;
    }
    setLoading(true);
    api
      .diff({ cwd, path, staged })
      .then((res) => {
        if (!cancelled) setResult(res);
      })
      .catch((error: unknown) => {
        if (!cancelled) setResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, path, staged, token]);

  const rows = useMemo(() => (result?.ok ? parseUnifiedDiff(result.diff) : []), [result]);
  const shown = useMemo(() => rows.slice(0, MAX_DIFF_ROWS), [rows]);
  const stats = useMemo(() => countDiffStats(rows), [rows]);
  const appearance = useSyncExternalStore(terminalSessionStore.subscribe, terminalSessionStore.getAppearance);
  const codeLang = useCodeLanguage(path);
  const tokenRows = useCodeHighlight('diff', shown, codeLang, appearance);
  const highlightedRows = useMemo(
    () => tokenRows?.map((rowTokens, index) =>
      rowTokens?.length && shown[index].text
        ? renderLineTokens(rowTokens)
        : shown[index].text || ' '
    ),
    [tokenRows, shown],
  );
  const lo = selection ? Math.min(selection.anchor, selection.focus) : -1;
  const hi = selection ? Math.max(selection.anchor, selection.focus) : -1;

  useEffect(() => {
    if (!rows.length) {
      onContext(null);
      return;
    }
    const picked = selection && lo < rows.length ? buildDiffSnippet(rows, lo, Math.min(hi, rows.length - 1)) : buildDiffSnippet(rows);
    const range = lineRangeText(picked.startLine, picked.endLine);
    onContext({
      relativePath: path,
      startLine: picked.startLine,
      endLine: picked.endLine,
      diffSnippet: picked.snippet,
      summary: selection ? `${range || '所选'}（${picked.rowCount} 行差异）` : '整个文件差异',
    });
  }, [rows, selection, lo, hi, path, onContext]);

  if (!result) return <PreviewLoading />;
  if (!result.ok) return <p className="wrp-preview-error">{result.error}</p>;
  if (!result.diff.trim()) {
    return <p className="wrp-preview-empty">{loading ? '加载中…' : '没有可显示的差异（可能仅为模式变更或已被还原）'}</p>;
  }
  const pick = (index: number) => (event: MouseEvent) => {
    event.preventDefault();
    onSelectLine(index, event.shiftKey);
  };
  return (
    <div className="wrp-preview-scroll">
      <div className="wrp-diff-stats">
        <span className="is-add">+{stats.added}</span>
        <span className="is-del">−{stats.removed}</span>
        {loading && <LoaderCircle size={12} className="wrp-spin" />}
        {result.truncated && <span className="wrp-warn">差异过大，已截断</span>}
      </div>
      <div className="wrp-diff" role="table" aria-label="文件差异">
        {shown.map((row, index) => {
          return (
            <div
              key={index}
              className={`wrp-diff-row is-${row.kind} ${index >= lo && index <= hi ? 'is-picked' : ''}`}
              role="row"
            >
              <span className="wrp-diff-ln is-pickable" aria-hidden onMouseDown={pick(index)} title="点击选择行，Shift+点击扩展">
                {row.oldLine ?? ''}
              </span>
              <span className="wrp-diff-ln is-pickable" aria-hidden onMouseDown={pick(index)} title="点击选择行，Shift+点击扩展">
                {row.newLine ?? ''}
              </span>
              <span className="wrp-diff-sign" aria-hidden>
                {row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ''}
              </span>
              <span className="wrp-diff-text">
                {highlightedRows ? highlightedRows[index] : row.text || ' '}
              </span>
            </div>
          );
        })}
      </div>
      {rows.length > MAX_DIFF_ROWS && (
        <p className="wrp-preview-empty">仅显示前 {MAX_DIFF_ROWS} 行差异，共 {rows.length} 行。</p>
      )}
    </div>
  );
}

function FileBody({
  target,
  token,
  selection,
  onSelectLine,
  onContext,
}: {
  target: Extract<PanelPreviewTarget, { kind: 'file' }>;
  token: string;
  selection: LineSelection | null;
  onSelectLine: (index: number, extend: boolean) => void;
  onContext: (context: PromptContext | null) => void;
}) {
  const [result, setResult] = useState<WorkspaceFsReadFileResult | null>(null);
  const { rootPath, relativePath } = target;

  useEffect(() => {
    setResult(null);
  }, [rootPath, relativePath]);

  useEffect(() => {
    let cancelled = false;
    const api = window.vibeMeet.workspaceFs;
    if (!api) {
      setResult({ ok: false, error: '文件接口不可用' });
      return;
    }
    api
      .readFile({ rootPath, filePath: relativePath })
      .then((res) => {
        if (!cancelled) setResult(res);
      })
      .catch((error: unknown) => {
        if (!cancelled) setResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [rootPath, relativePath, token]);

  const lines = useMemo(() => {
    if (!result?.ok || result.content === null) return [];
    const all = result.content.replace(/\r\n/g, '\n').split('\n');
    if (all.length > 1 && all.at(-1) === '') all.pop();
    return all;
  }, [result]);

  const shown = useMemo(() => lines.slice(0, MAX_FILE_LINES), [lines]);
  const appearance = useSyncExternalStore(terminalSessionStore.subscribe, terminalSessionStore.getAppearance);
  const codeLang = useCodeLanguage(relativePath);
  const tokenLines = useCodeHighlight('code', shown, codeLang, appearance);
  const highlightedCode = useMemo(
    () => tokenLines?.map((lineTokens, i) => (
      <Fragment key={i}>
        {lineTokens?.length && shown[i] ? renderLineTokens(lineTokens) : shown[i]}
        {i < tokenLines.length - 1 ? '\n' : null}
      </Fragment>
    )),
    [tokenLines, shown],
  );
  const shownCount = Math.min(lines.length, MAX_FILE_LINES);
  const lo = selection ? Math.min(selection.anchor, selection.focus, shownCount - 1) : -1;
  const hi = selection ? Math.min(Math.max(selection.anchor, selection.focus), shownCount - 1) : -1;

  useEffect(() => {
    if (!result?.ok) {
      onContext(null);
      return;
    }
    if (selection && lo >= 0) {
      onContext({
        relativePath,
        startLine: lo + 1,
        endLine: hi + 1,
        summary: lineRangeText(lo + 1, hi + 1),
      });
    } else {
      onContext({ relativePath, summary: '整个文件' });
    }
  }, [result, selection, lo, hi, relativePath, onContext]);

  if (!result) return <PreviewLoading />;
  if (!result.ok) return <p className="wrp-preview-error">{result.error}</p>;
  if (result.binary) {
    return <p className="wrp-preview-empty">二进制文件（{formatFileSize(result.size)}），不支持预览。</p>;
  }
  const hasVisibleCode = shown.length > 1 || (shown[0] ?? '') !== '';
  const onGutter = (event: MouseEvent<HTMLPreElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const index = Math.floor((event.clientY - rect.top) / CODE_LINE_HEIGHT);
    if (index >= 0 && index < shown.length) onSelectLine(index, event.shiftKey);
  };
  return (
    <div className="wrp-preview-scroll">
      <div className="wrp-diff-stats">
        <span>{formatFileSize(result.size)}</span>
        <span>{lines.length} 行</span>
        {result.truncated && <span className="wrp-warn">文件过大，仅显示开头部分</span>}
      </div>
      <div className="wrp-code">
        {lo >= 0 && (
          <div
            className="wrp-code-pick"
            style={{ top: lo * CODE_LINE_HEIGHT, height: (hi - lo + 1) * CODE_LINE_HEIGHT }}
            aria-hidden
          />
        )}
        <pre className="wrp-code-gutter is-pickable" aria-hidden onMouseDown={onGutter} title="点击选择行，Shift+点击扩展">
          {shown.map((_, i) => i + 1).join('\n')}
        </pre>
        <pre className="wrp-code-text">
          {highlightedCode && hasVisibleCode
            ? highlightedCode
            : shown.join('\n') || ' '}
        </pre>
      </div>
      {lines.length > MAX_FILE_LINES && (
        <p className="wrp-preview-empty">仅显示前 {MAX_FILE_LINES} 行。</p>
      )}
    </div>
  );
}

function defaultTarget(targets: AgentPromptTarget[]): AgentPromptTarget | undefined {
  return (
    targets.find((t) => t.isActive && t.isAgent) ??
    targets.find((t) => t.isAgent && isAgentStatusVisible(t.status)) ??
    targets.find((t) => t.isAgent) ??
    targets.find((t) => t.isActive) ??
    targets[0]
  );
}

function AgentComposer({
  rootPath,
  context,
  hasSelection,
  onClearSelection,
  targets,
  onSent,
  onClose,
}: {
  rootPath: string;
  context: PromptContext | null;
  hasSelection: boolean;
  onClearSelection: () => void;
  targets: AgentPromptTarget[];
  onSent: (target: AgentPromptTarget) => void;
  onClose: () => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const target = targets.find((t) => t.ptyId === chosen) ?? defaultTarget(targets);

  useEffect(() => {
    if (feedback?.kind !== 'ok') return;
    const timer = setTimeout(() => setFeedback(null), 3000);
    return () => clearTimeout(timer);
  }, [feedback]);

  const send = async (submit: boolean) => {
    const api = window.vibeMeet.agent;
    if (!api || !target || !context || busy) return;
    const absolute = joinHostPath(rootPath, context.relativePath.replace(/\//g, rootPath.includes('\\') ? '\\' : '/'));
    const filePath = (target.cwd && relativeFromDir(target.cwd, absolute)) || absolute;
    const fitted = fitPromptParts({ prompt, filePath, diffSnippet: context.diffSnippet });
    if (fitted.overLimit) {
      setFeedback({ kind: 'error', text: '说明文字过长，请缩短后再发送' });
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      const res = await api.sendPrompt({
        ptyId: target.ptyId,
        prompt,
        filePath,
        ...(context.startLine !== undefined ? { startLine: context.startLine } : {}),
        ...(context.endLine !== undefined ? { endLine: context.endLine } : {}),
        ...(fitted.diffSnippet ? { diffSnippet: fitted.diffSnippet } : {}),
        submit,
      });
      if (!res.ok) {
        setFeedback({ kind: 'error', text: res.error });
        return;
      }
      setPrompt('');
      setFeedback({
        kind: 'ok',
        text: `${submit ? '已发送到' : '已粘贴到'} ${target.label}${fitted.truncated ? '（差异过长，已截断）' : ''}`,
      });
      onSent(target);
    } catch (error) {
      setFeedback({ kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send(true);
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
  };

  if (!window.vibeMeet.agent) {
    return <div className="wrp-composer"><p className="wrp-hint">Agent 接口不可用</p></div>;
  }

  return (
    <div className="wrp-composer" aria-label="发送到 Agent">
      <div className="wrp-composer-row">
        <Bot size={13} />
        {targets.length ? (
          <select
            aria-label="目标终端"
            value={target?.ptyId ?? ''}
            onChange={(event) => setChosen(event.target.value)}
          >
            {targets.map((t) => (
              <option key={t.ptyId} value={t.ptyId}>
                {t.label}
                {isAgentStatusVisible(t.status) ? ` · ${agentStatusLabel(t.status)}` : ''}
                {t.isActive ? '（当前）' : ''}
              </option>
            ))}
          </select>
        ) : (
          <span className="wrp-hint is-inline">当前项目没有打开的终端</span>
        )}
        <span className="wrp-composer-context" title={context?.relativePath}>
          {context?.summary ?? '—'}
        </span>
        {hasSelection && (
          <button type="button" className="wrp-link" onClick={onClearSelection}>
            清除选择
          </button>
        )}
        <button type="button" className="wrp-icon-btn" aria-label="关闭" title="关闭" onClick={onClose}>
          <X size={12} />
        </button>
      </div>
      <textarea
        aria-label="给 Agent 的说明"
        rows={2}
        placeholder="补充说明（可选）。Enter 发送，Shift+Enter 换行"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={onKey}
      />
      <div className="wrp-composer-row">
        {target && !target.isAgent && <small className="wrp-warn">目标是普通 Shell，内容会粘贴到命令行</small>}
        {feedback && (
          <small className={feedback.kind === 'ok' ? 'wrp-ok' : 'wrp-error-text'} role="status">
            {feedback.text}
          </small>
        )}
        <span className="wrp-composer-spacer" />
        <button
          type="button"
          className="wrp-btn"
          disabled={!target || !context || busy}
          title="粘贴到终端但不发送"
          onClick={() => void send(false)}
        >
          <ClipboardPaste size={12} /> 仅粘贴
        </button>
        <button
          type="button"
          className="wrp-btn is-primary"
          disabled={!target || !context || busy}
          onClick={() => void send(true)}
        >
          {busy ? <LoaderCircle size={12} className="wrp-spin" /> : <Send size={12} />} 发送
        </button>
      </div>
    </div>
  );
}

function PreviewLoading() {
  return (
    <p className="wrp-preview-empty">
      <LoaderCircle size={13} className="wrp-spin" /> 加载中…
    </p>
  );
}
