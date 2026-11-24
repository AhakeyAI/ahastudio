// Visual structure adapted from T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.),
// apps/web/src/components/chat/ChangedFilesTree.tsx and DiffStatLabel.tsx.
import { Fragment, memo, useMemo, useState } from 'react';
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, FileDiff, FileText, Folder, FolderOpen } from 'lucide-react';
import { buildChangeTree, formatDiffCount, type ChangeTreeNode, type TurnChanges, type TurnChangedFile } from '../../lib/turn-changes';
import { DiffBlock } from './SessionCode';
import { openSessionTarget, useAgentSession } from './session-context';

const CHANGE_LABEL = { add: '新增', delete: '删除' } as const;

export function DiffStatLabel({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="asv-diffstat" aria-label={`新增 ${added} 行，删除 ${removed} 行`}>
      <span className="is-add">+{formatDiffCount(added)}</span>
      <span className="is-del">-{formatDiffCount(removed)}</span>
    </span>
  );
}

function FileDetail({ file }: { file: TurnChangedFile }) {
  const session = useAgentSession();
  const target = file.movePath ?? file.path;
  return (
    <div className="asv-changes-detail">
      <div className="asv-file-head">
        {file.movePath && <span className="asv-detail-note is-mono">{file.path} → {file.movePath}</span>}
        <button type="button" className="asv-text-btn" onClick={() => void openSessionTarget(target, session)}>打开文件</button>
      </div>
      {file.parts.map((part, index) => (
        <DiffBlock key={index} diff={part.diff} path={target} change={part.change} />
      ))}
      {file.truncated && <div className="asv-detail-note">差异较长，已截断</div>}
    </div>
  );
}

const collectDirectories = (nodes: readonly ChangeTreeNode[]): string[] =>
  nodes.flatMap((node) => (node.kind === 'directory' ? [node.path, ...collectDirectories(node.children)] : []));

/** "本轮改动": every file the finished turn changed, as a tree with per-file diffs opened in place. */
export const TurnChangesCard = memo(function TurnChangesCard({ changes }: { changes: TurnChanges }) {
  const tree = useMemo(() => buildChangeTree(changes.files), [changes.files]);
  const directories = useMemo(() => collectDirectories(tree), [tree]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (set: ReadonlySet<string>, key: string) => {
    const next = new Set(set);
    if (!next.delete(key)) next.add(key);
    return next;
  };
  const allCollapsed = directories.length > 0 && directories.every((path) => collapsed.has(path));

  const renderNodes = (nodes: readonly ChangeTreeNode[], depth: number) => nodes.map((node) => {
    const indent = { paddingLeft: 8 + depth * 14 };
    if (node.kind === 'directory') {
      const expanded = !collapsed.has(node.path);
      return (
        <Fragment key={`d:${node.path}`}>
          <button type="button" className="asv-changes-row is-dir" style={indent} aria-expanded={expanded}
            onClick={() => setCollapsed((set) => toggle(set, node.path))}>
            <ChevronRight size={13} className="asv-changes-chevron" aria-hidden="true" />
            {expanded ? <FolderOpen size={14} aria-hidden="true" /> : <Folder size={14} aria-hidden="true" />}
            <span className="asv-changes-name">{node.name}</span>
            <DiffStatLabel added={node.stat.added} removed={node.stat.removed} />
          </button>
          {expanded && renderNodes(node.children, depth + 1)}
        </Fragment>
      );
    }
    const isOpen = open.has(node.path);
    const { file } = node;
    return (
      <Fragment key={`f:${node.path}`}>
        <button type="button" className="asv-changes-row is-file" style={indent} aria-expanded={isOpen}
          title={file.displayPath} onClick={() => setOpen((set) => toggle(set, node.path))}>
          <ChevronRight size={13} className="asv-changes-chevron" aria-hidden="true" />
          <FileText size={14} aria-hidden="true" />
          <span className="asv-changes-name is-file">{node.name}</span>
          {file.change !== 'update' && <span className={`asv-changes-kind is-${file.change}`}>{CHANGE_LABEL[file.change]}</span>}
          <DiffStatLabel added={file.added} removed={file.removed} />
        </button>
        {isOpen && <div style={{ paddingLeft: 8 + depth * 14 }}><FileDetail file={file} /></div>}
      </Fragment>
    );
  });

  return (
    <div className="asv-changes" data-asv-row>
      <div className="asv-changes-head">
        <FileDiff size={14} aria-hidden="true" />
        <span className="asv-changes-title">本轮改动</span>
        <span className="asv-changes-count">{changes.files.length} 个文件</span>
        <DiffStatLabel added={changes.added} removed={changes.removed} />
        <span className="asv-spacer" />
        {directories.length > 0 && (
          <button type="button" className="asv-icon-btn" aria-label={allCollapsed ? '展开全部文件夹' : '收起全部文件夹'}
            title={allCollapsed ? '展开全部文件夹' : '收起全部文件夹'}
            onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(directories))}>
            {allCollapsed ? <ChevronsUpDown size={13} /> : <ChevronsDownUp size={13} />}
          </button>
        )}
      </div>
      <div className="asv-changes-body">{renderNodes(tree, 0)}</div>
    </div>
  );
});
