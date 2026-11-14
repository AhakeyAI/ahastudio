import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  Eye,
  EyeOff,
  File,
  Folder,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react';
import { gitStatusLetterLabel, gitStatusTone } from '../lib/git-panel-model';
import type { WorkspaceFsTreeEntry } from '../types';
import { IconButton } from './GitChangesPanel';
import { previewKey, type PanelPreviewTarget } from './PanelPreview';

interface DirState {
  loading: boolean;
  entries: WorkspaceFsTreeEntry[];
  truncated: boolean;
  error: string | null;
}

const EMPTY_DIR: DirState = { loading: true, entries: [], truncated: false, error: null };

export interface TreeDecorations {
  files: Map<string, string>;
  dirs: Set<string>;
}

export function WorkspaceFilesPanel({
  rootPath,
  decorations,
  selectedKey,
  refreshSignal,
  onPreview,
}: {
  rootPath: string;
  decorations: TreeDecorations | null;
  selectedKey: string;
  /** Changes when the tree should reload every expanded directory. */
  refreshSignal: number;
  onPreview: (target: PanelPreviewTarget) => void;
}) {
  const [showHidden, setShowHidden] = useState(() => localStorage.getItem('aha.files.showHidden') === '1');
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const generation = useRef(0);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  const load = useCallback(
    async (relativePath: string, gen: number) => {
      const api = window.vibeMeet.workspaceFs;
      setDirs((prev) => ({
        ...prev,
        [relativePath]: { ...(prev[relativePath] ?? EMPTY_DIR), loading: true },
      }));
      let next: DirState;
      if (!api) {
        next = { loading: false, entries: [], truncated: false, error: '文件接口不可用' };
      } else {
        try {
          const res = await api.listTree({ rootPath, relativePath, showHidden });
          next = res.ok
            ? { loading: false, entries: res.entries, truncated: res.truncated, error: null }
            : { loading: false, entries: [], truncated: false, error: res.error };
        } catch (error) {
          next = {
            loading: false,
            entries: [],
            truncated: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
      if (gen !== generation.current) return;
      setDirs((prev) => ({ ...prev, [relativePath]: next }));
    },
    [rootPath, showHidden],
  );

  useEffect(() => {
    const gen = ++generation.current;
    setDirs({});
    setExpanded(new Set());
    void load('', gen);
  }, [load]);

  const reloadAll = useCallback(() => {
    const gen = generation.current;
    void load('', gen);
    for (const rel of expandedRef.current) void load(rel, gen);
  }, [load]);

  const firstSignal = useRef(true);
  useEffect(() => {
    if (firstSignal.current) {
      firstSignal.current = false;
      return;
    }
    reloadAll();
  }, [refreshSignal, reloadAll]);

  const toggleDir = (rel: string) => {
    const next = new Set(expanded);
    if (next.has(rel)) {
      next.delete(rel);
    } else {
      next.add(rel);
      if (!dirs[rel] || dirs[rel].error) void load(rel, generation.current);
    }
    setExpanded(next);
  };

  const renderDir = (rel: string, depth: number): ReactElement[] => {
    const state = dirs[rel];
    if (!state || (state.loading && !state.entries.length)) {
      return [
        <div key={`${rel}::loading`} className="wrp-tree-note" style={{ paddingLeft: 10 + depth * 14 }}>
          <LoaderCircle size={12} className="wrp-spin" /> 加载中…
        </div>,
      ];
    }
    if (state.error) {
      return [
        <div key={`${rel}::error`} className="wrp-tree-note is-error" style={{ paddingLeft: 10 + depth * 14 }}>
          {state.error}
        </div>,
      ];
    }
    const rows: ReactElement[] = [];
    if (!state.entries.length && depth > 0) {
      rows.push(
        <div key={`${rel}::empty`} className="wrp-tree-note" style={{ paddingLeft: 10 + depth * 14 }}>
          空目录
        </div>,
      );
    }
    for (const entry of state.entries) {
      const isDir = entry.kind === 'directory';
      const open = isDir && expanded.has(entry.relativePath);
      const letter = !isDir ? decorations?.files.get(entry.relativePath) : undefined;
      const dirty = isDir && decorations?.dirs.has(entry.relativePath);
      const tone = letter ? gitStatusTone(letter) : null;
      const key = previewKey({ kind: 'file', rootPath, relativePath: entry.relativePath });
      rows.push(
        <button
          type="button"
          key={entry.relativePath}
          className={`wrp-tree-row ${!isDir && selectedKey === key ? 'is-selected' : ''}`}
          style={{ paddingLeft: 6 + depth * 14 }}
          title={entry.isSymlink ? `${entry.relativePath}（符号链接）` : entry.relativePath}
          aria-expanded={isDir ? open : undefined}
          onClick={() =>
            isDir
              ? toggleDir(entry.relativePath)
              : onPreview({ kind: 'file', rootPath, relativePath: entry.relativePath })
          }
        >
          <span className="wrp-tree-chevron">
            {isDir ? open ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}
          </span>
          {isDir ? (
            open ? <FolderOpen size={14} className="wrp-tree-icon is-dir" /> : <Folder size={14} className="wrp-tree-icon is-dir" />
          ) : (
            <File size={14} className="wrp-tree-icon" />
          )}
          <span className={`wrp-tree-name ${tone ? `is-${tone}` : ''} ${entry.isSymlink ? 'is-link' : ''}`}>
            {entry.name}
          </span>
          {dirty && <span className="wrp-tree-dot" aria-label="包含更改" />}
          {letter && (
            <span className={`wrp-letter is-${tone}`} aria-label={gitStatusLetterLabel(letter)}>
              {letter}
            </span>
          )}
        </button>,
      );
      if (open) rows.push(...renderDir(entry.relativePath, depth + 1));
    }
    if (state.truncated) {
      rows.push(
        <div key={`${rel}::truncated`} className="wrp-tree-note" style={{ paddingLeft: 10 + depth * 14 }}>
          条目过多，仅显示前 1000 项
        </div>,
      );
    }
    return rows;
  };

  const rootName = rootPath.split(/[\\/]/).filter(Boolean).at(-1) ?? rootPath;
  const root = dirs[''];

  return (
    <div className="wrp-files">
      <div className="wrp-subbar">
        <span className="wrp-subbar-title" title={rootPath}>
          {rootName}
        </span>
        {root?.loading && <LoaderCircle size={12} className="wrp-spin" />}
        <IconButton
          label={showHidden ? '隐藏隐藏文件' : '显示隐藏文件'}
          className={showHidden ? 'is-active' : ''}
          onClick={() => {
            const next = !showHidden;
            localStorage.setItem('aha.files.showHidden', next ? '1' : '0');
            setShowHidden(next);
          }}
        >
          {showHidden ? <Eye size={13} /> : <EyeOff size={13} />}
        </IconButton>
        <IconButton label="全部折叠" onClick={() => setExpanded(new Set())}>
          <ChevronsDownUp size={13} />
        </IconButton>
        <IconButton label="刷新文件树" onClick={reloadAll}>
          <RefreshCw size={13} />
        </IconButton>
      </div>
      <div className="wrp-tree" role="tree" aria-label="工作区文件">
        {renderDir('', 0)}
        {root && !root.loading && !root.error && !root.entries.length && (
          <p className="wrp-hint">目录为空</p>
        )}
      </div>
    </div>
  );
}
