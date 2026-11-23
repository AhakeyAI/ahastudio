// Composer suggestion menu for `/`, `$`, and `@` triggers.
// Adapted from T3 Code (apps/web/src/components/chat/ComposerCommandMenu.tsx, MIT, Copyright (c) 2026 T3 Tools Inc.).

import { memo, useLayoutEffect, useRef } from 'react';
import {
  Blocks,
  Cpu,
  Eraser,
  FileText,
  Folder,
  Gauge,
  History,
  MessageSquareWarning,
  Minimize2,
  Package,
  PencilLine,
  Settings,
  Sparkles,
  Target,
  UserRound,
  Workflow,
} from 'lucide-react';
import {
  SKILL_SOURCE_LABELS,
  type SkillSourceKind,
  type SlashCommandItem,
} from '../../lib/composer-slash-commands';
import type { ComposerTrigger } from '../../lib/composer-tokens';
import type { CodexFileMatch, CodexSkillOption } from '../../types';

export type ComposerSuggestion =
  | { kind: 'slash'; id: string; item: SlashCommandItem }
  | { kind: 'skill'; id: string; skill: CodexSkillOption; sourceKind: SkillSourceKind }
  | { kind: 'file'; id: string; file: CodexFileMatch };

const MENU_HEADINGS: Record<ComposerTrigger['kind'], string> = {
  slash: '斜杠命令',
  skill: '技能',
  file: '文件',
};

const MENU_LOADING: Record<ComposerTrigger['kind'], string> = {
  slash: '正在读取技能…',
  skill: '正在读取技能…',
  file: '正在搜索文件…',
};

const MENU_EMPTY: Record<ComposerTrigger['kind'], string> = {
  slash: '没有匹配的命令',
  skill: '没有匹配的技能，可输入 / 浏览命令',
  file: '没有匹配的文件',
};

function SlashIcon({ item }: { item: SlashCommandItem }) {
  if (item.type === 'skill') return <Sparkles size={13} aria-hidden="true" />;
  switch (item.command) {
    case 'model': return <Cpu size={13} aria-hidden="true" />;
    case 'clear': return <Eraser size={13} aria-hidden="true" />;
    case 'compact': return <Minimize2 size={13} aria-hidden="true" />;
    case 'usage-limits': return <Gauge size={13} aria-hidden="true" />;
    case 'goal': return <Target size={13} aria-hidden="true" />;
    case 'feedback': return <MessageSquareWarning size={13} aria-hidden="true" />;
    case 'history': return <History size={13} aria-hidden="true" />;
    case 'rename': return <PencilLine size={13} aria-hidden="true" />;
    case 'orchestration': return <Workflow size={13} aria-hidden="true" />;
  }
}

function SkillSourceBadge({ kind, showSkillSuffix }: { kind: SkillSourceKind; showSkillSuffix: boolean }) {
  const Icon = kind === 'app' ? Blocks
    : kind === 'repo' || kind === 'project' ? Folder
      : kind === 'personal' ? UserRound
        : kind === 'system' ? Settings
          : Package;
  const labels = SKILL_SOURCE_LABELS[kind];
  return (
    <span className="asv-suggest-badge">
      <Icon size={11} aria-hidden="true" />
      <span>{showSkillSuffix ? labels.skillLabel : labels.label}</span>
    </span>
  );
}

const ComposerCommandMenuRow = memo(function ComposerCommandMenuRow({
  suggestion,
  active,
  onHighlight,
  onSelect,
}: {
  suggestion: ComposerSuggestion;
  active: boolean;
  onHighlight: (id: string) => void;
  onSelect: (suggestion: ComposerSuggestion) => void;
}) {
  const description = suggestion.kind === 'slash'
    ? suggestion.item.description
    : suggestion.kind === 'skill'
      ? suggestion.skill.description || SKILL_SOURCE_LABELS[suggestion.sourceKind].skillLabel
      : suggestion.file.path;
  const hint = suggestion.kind === 'slash' && suggestion.item.type !== 'skill' ? suggestion.item.hint : undefined;
  const sourceKind = suggestion.kind === 'slash' && suggestion.item.type === 'skill'
    ? suggestion.item.sourceKind
    : suggestion.kind === 'skill'
      ? suggestion.sourceKind
      : null;

  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      data-composer-item-id={suggestion.id}
      className={`asv-suggest-row${active ? ' is-active' : ''}`}
      onMouseMove={() => {
        if (!active) onHighlight(suggestion.id);
      }}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onSelect(suggestion)}
    >
      {suggestion.kind === 'slash' ? (
        <SlashIcon item={suggestion.item} />
      ) : suggestion.kind === 'skill' ? (
        <Sparkles size={13} aria-hidden="true" />
      ) : (
        <FileText size={13} aria-hidden="true" />
      )}
      <span className="asv-suggest-title">
        {suggestion.kind === 'slash' && suggestion.item.type === 'skill' ? (
          <>
            <span className="asv-suggest-prefix">/skill:</span>
            {suggestion.item.skill.name}
          </>
        ) : suggestion.kind === 'slash' ? (
          suggestion.item.label
        ) : suggestion.kind === 'skill' ? (
          suggestion.skill.name
        ) : (
          suggestion.file.fileName
        )}
      </span>
      {hint && <span className="asv-suggest-hint">{hint}</span>}
      <span className="asv-suggest-desc" title={description}>{description}</span>
      {sourceKind && (
        <SkillSourceBadge kind={sourceKind} showSkillSuffix={suggestion.kind === 'skill'} />
      )}
    </button>
  );
});

export const ComposerCommandMenu = memo(function ComposerCommandMenu({
  triggerKind,
  items,
  activeItemId,
  loading,
  onHighlight,
  onSelect,
}: {
  triggerKind: ComposerTrigger['kind'];
  items: readonly ComposerSuggestion[];
  activeItemId: string | null;
  loading: boolean;
  onHighlight: (id: string) => void;
  onSelect: (suggestion: ComposerSuggestion) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!activeItemId || !listRef.current) return;
    const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(activeItemId)
      : activeItemId.replace(/["\\]/gu, '\\$&');
    const el = listRef.current.querySelector<HTMLElement>(`[data-composer-item-id="${escaped}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeItemId]);

  return (
    <div className="asv-suggest" role="listbox" aria-label={MENU_HEADINGS[triggerKind]}>
      <div className="asv-suggest-head">
        <span>{MENU_HEADINGS[triggerKind]}</span>
        {loading && <span className="asv-suggest-head-status">{MENU_LOADING[triggerKind]}</span>}
      </div>
      {items.length > 0 ? (
        <div className="asv-suggest-list" ref={listRef}>
          {items.map((item) => (
            <ComposerCommandMenuRow
              key={item.id}
              suggestion={item}
              active={item.id === activeItemId}
              onHighlight={onHighlight}
              onSelect={onSelect}
            />
          ))}
        </div>
      ) : (
        <div className="asv-suggest-empty">{loading ? MENU_LOADING[triggerKind] : MENU_EMPTY[triggerKind]}</div>
      )}
      <div className="asv-suggest-foot">↑↓ 选择 · Tab / Enter 确认 · Esc 关闭</div>
    </div>
  );
});
