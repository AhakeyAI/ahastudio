import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import {
  ArrowUp, ChevronDown, FileText, GitBranch, Globe, Loader2, Lock, MessageCircleQuestion, Paperclip, ShieldAlert, Square, X,
} from 'lucide-react';
import { composerDrafts, type ComposerDraftAttachment } from '../../lib/composer-drafts';
import { prepareImageForAttachment } from '../../lib/image-compression';
import { formatTokenCount } from '../../lib/worker-timeline-model';
import type { UsageSummary } from '../../lib/usage-limits';
import { resolveTitleEdit } from '../../lib/session-title';
import { UsageLimitChip } from './UsageLimitChip';
import { POLICY_LABELS, codexCatalogClient } from '../../lib/agent-session-client';
import { CODEX_CAPABILITIES } from '../../lib/session-capabilities';
import {
  buildSlashCommandItems,
  isClearCommand,
  isCompactCommand,
  isHistoryCommand,
  isModelCommand,
  isUsageLimitsCommand,
  parseFeedbackCommand,
  parseGoalCommand,
  parseOrchestrationCommand,
  parseRenameCommand,
  resolveMenuActiveItemId,
  resolveSkillSourceKind,
  runsSlashCommandLocally,
  searchSkills,
  searchSlashCommandItems,
  type GoalCommandAction,
} from '../../lib/composer-slash-commands';
import {
  applyCompletion, detectTrigger, fileMention, isSameTrigger, removeTriggerRange, resolveModelChoice, skillMention,
  skillsInText, type ComposerTrigger,
} from '../../lib/composer-tokens';
import type {
  AgentDriverCapabilities, AgentDriverId, AgentQueuedMessage, AgentSessionGoal, AgentSessionInfo, AgentSessionPolicy, AgentTurnAttachment, CodexFileMatch,
  CodexModelOption, CodexSkillOption, OrchestrationQuestionRecord, WorkerTimelineItem,
} from '../../types';
import {
  FeedbackBanner, FreshSessionBanner, GoalBanner, UsageLimitsBanner, type FeedbackBannerState,
} from './ComposerBanners';
import { ComposerCatalogPanel } from './ComposerCatalogPanel';
import { ComposerCommandMenu, type ComposerSuggestion } from './ComposerCommandMenu';
import { ComposerModelPicker } from './ComposerModelPicker';
import { SessionQueue } from './SessionQueue';
import { useAgentSession } from './session-context';

type ApprovalItem = Extract<WorkerTimelineItem, { kind: 'approval' }>;

const COMPOSER_MAX_HEIGHT = 200;

function ApprovalBanner({ item }: { item: ApprovalItem }) {
  const { onNotify, resolveApproval } = useAgentSession();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const api = window.vibeMeet?.orchestration;
  const decide = async (allow: boolean) => {
    const call = allow ? api?.approve : api?.deny;
    if (!resolveApproval && !call) return;
    setBusy(true);
    try {
      const denial = reason.trim() || 'Denied from Agent session';
      const res = resolveApproval
        ? await resolveApproval(item.approvalId, allow, allow ? undefined : denial)
        : await call!({ id: item.approvalId, ...(allow ? {} : { reason: denial }) });
      if (!res.ok) onNotify?.(res.error ?? '操作失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="asv-banner is-approval" role="group" aria-label="授权请求">
      <div className="asv-banner-head">
        <ShieldAlert size={14} />
        <span className="asv-banner-title">需要授权</span>
        <code className="asv-banner-tool">{item.tool || item.method}</code>
      </div>
      {item.input && <pre className="asv-banner-detail">{item.input}</pre>}
      {item.reason && <div className="asv-banner-note">{item.reason}</div>}
      <div className="asv-banner-actions">
        <input
          className="asv-banner-input"
          placeholder="拒绝原因（可选）"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          aria-label="拒绝原因"
        />
        <button type="button" className="asv-btn" disabled={busy} onClick={() => void decide(false)}>拒绝</button>
        <button type="button" className="asv-btn is-primary" disabled={busy} onClick={() => void decide(true)}>允许</button>
      </div>
    </div>
  );
}

function QuestionBanner({ question }: { question: OrchestrationQuestionRecord }) {
  const { onNotify } = useAgentSession();
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const reply = async (body: string) => {
    const api = window.vibeMeet?.orchestration?.reply;
    const text = body.trim();
    if (!api || !text) return;
    setBusy(true);
    try {
      const res = await api({ id: question.messageId, body: text });
      if (!res.ok) onNotify?.(res.error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="asv-banner is-question" role="group" aria-label="Worker 提问">
      <div className="asv-banner-head">
        <MessageCircleQuestion size={14} />
        <span className="asv-banner-title">Worker 在等你的答复</span>
      </div>
      <div className="asv-banner-question">{question.question}</div>
      {question.options.length > 0 && (
        <div className="asv-banner-options">
          {question.options.map((option) => (
            <button key={option} type="button" className="asv-btn" disabled={busy} onClick={() => void reply(option)}>{option}</button>
          ))}
        </div>
      )}
      <div className="asv-banner-actions">
        <input
          className="asv-banner-input"
          placeholder="输入答复"
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) void reply(answer);
          }}
          aria-label="答复"
        />
        <button type="button" className="asv-btn is-primary" disabled={busy || !answer.trim()} onClick={() => void reply(answer)}>答复</button>
      </div>
    </div>
  );
}

type DirectQuestion = AgentSessionInfo['pendingQuestions'][number];

/** Questions the agent asked through its own protocol; every question needs an answer before sending. */
function DirectQuestionBanner({ entry, onAnswer }: {
  entry: DirectQuestion;
  onAnswer: (requestId: string, answers: Record<string, string[]> | null) => Promise<boolean>;
}) {
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const complete = entry.questions.every((question) => picked[question.id]?.trim());
  const submit = async (answers: Record<string, string[]> | null) => {
    setBusy(true);
    try {
      await onAnswer(entry.requestId, answers);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="asv-banner is-question" role="group" aria-label="Codex 提问">
      <div className="asv-banner-head">
        <MessageCircleQuestion size={14} />
        <span className="asv-banner-title">Codex 在等你的答复</span>
      </div>
      {entry.questions.map((question) => (
        <div key={question.id} className="asv-banner-qa">
          <div className="asv-banner-question">
            {question.header && <strong>{question.header}</strong>} {question.prompt}
          </div>
          {question.options.length > 0 && (
            <div className="asv-banner-options">
              {question.options.map((option) => (
                <button key={option.label} type="button" title={option.description || undefined}
                  className={`asv-btn${picked[question.id] === option.label ? ' is-primary' : ''}`}
                  aria-pressed={picked[question.id] === option.label} disabled={busy}
                  onClick={() => setPicked((prev) => ({ ...prev, [question.id]: option.label }))}>
                  {option.label}
                </button>
              ))}
            </div>
          )}
          {question.allowOther && (
            <input className="asv-banner-input" placeholder={question.options.length ? '或输入其他答复' : '输入答复'}
              aria-label={`${question.header || question.prompt} 的答复`} disabled={busy}
              value={question.options.some((option) => option.label === picked[question.id]) ? '' : picked[question.id] ?? ''}
              onChange={(event) => setPicked((prev) => ({ ...prev, [question.id]: event.target.value }))} />
          )}
        </div>
      ))}
      <div className="asv-banner-actions">
        <span className="asv-strip-spacer" />
        <button type="button" className="asv-btn" disabled={busy} onClick={() => void submit(null)}>跳过</button>
        <button type="button" className="asv-btn is-primary" disabled={busy || !complete}
          onClick={() => void submit(Object.fromEntries(entry.questions.map((question) => [question.id, [picked[question.id]!.trim()]])))}>
          答复
        </button>
      </div>
    </div>
  );
}

function Chip({ icon, children, title }: { icon: ReactNode; children: ReactNode; title?: string }) {
  return (
    <span className="asv-chip" title={title}>
      {icon}
      <span>{children}</span>
    </span>
  );
}


export interface SessionComposerProps {
  alive: boolean;
  running: boolean;
  sending: boolean;
  interrupting: boolean;
  approvals: readonly ApprovalItem[];
  questions: readonly OrchestrationQuestionRecord[];
  branch: string | null;
  readOnly?: boolean;
  /** Direct sessions only: the permission level, switchable between turns. */
  policy?: AgentSessionPolicy;
  onPolicyChange?: (policy: AgentSessionPolicy) => void;
  network?: boolean;
  onNetworkChange?: (network: boolean) => void;
  directQuestions?: readonly DirectQuestion[];
  onAnswer?: (requestId: string, answers: Record<string, string[]> | null) => Promise<boolean>;
  /** The session is not running but sending a message resumes it. */
  resumable?: boolean;
  /** Replaces the ended-session line, e.g. while a terminal pane continues the conversation. */
  endedText?: string;
  /** Direct sessions take one turn at a time, so sending waits for the running turn. */
  direct?: boolean;
  /** Direct sessions: a message sent while a turn runs is queued for after it, listed above the input. */
  queue?: ComposerQueue;
  usage: { input: number; output: number; total: number } | null;
  /** The person's Codex usage limits; direct sessions only. */
  usageLimits?: UsageSummary | null;
  /** Direct sessions: model and effort, `/` slash commands, `$` skills, `@` files, attachments, and the plugin panel. */
  toolbar?: ComposerToolbar;
  /** Direct sessions only: slash command actions and inline command banners. */
  slash?: ComposerSlashControl;
  /** Keeps the unsent draft across tab switches (and its text across restarts) under this key. */
  draftKey?: string;
  /** Resolves true once the message was accepted, which clears the draft. */
  onSend: (text: string, attachments: AgentTurnAttachment[], options?: { freshContext?: boolean }) => Promise<boolean>;
  onInterrupt: () => void;
  handleRef?: Ref<ComposerHandle>;
}

export interface ComposerSlashControl {
  currentTitle: string;
  hasTurns: boolean;
  hasUsageLimits: boolean;
  canHistory: boolean;
  canRename: boolean;
  canOrchestration: boolean;
  orchestrationOn: boolean;
  /** Driver capability flags; each defaults to on (Codex). */
  canCompact?: boolean;
  canGoal?: boolean;
  canFeedback?: boolean;
  canModel?: boolean;
  freshSessionArmed: boolean;
  goal: AgentSessionGoal | null;
  goalBusy: boolean;
  usageLimitsOpen: boolean;
  usageLimitsRefreshing: boolean;
  feedback: FeedbackBannerState | null;
  onArmFreshSession: () => void;
  onDisarmFreshSession: () => void;
  onOpenUsageLimits: () => void;
  onRefreshUsageLimits: () => void;
  onCloseUsageLimits: () => void;
  onOpenHistory: () => void;
  onRename: (title: string) => Promise<boolean>;
  onSetOrchestration: (mode: 'toggle' | 'on' | 'off') => void;
  onGoalCommand: (action: GoalCommandAction) => Promise<boolean>;
  onFeedbackCommand: (reason?: string) => void;
  onDismissFeedback: () => void;
}

export interface ComposerHandle {
  /** Replaces the draft text and focuses the input with the caret at the end; nothing is sent. */
  fill: (text: string) => void;
}

export interface ComposerQueue {
  items: readonly AgentQueuedMessage[];
  paused: boolean;
  /** Takes a message out of the queue; resolves null when it already went out. */
  take: (id: string) => Promise<AgentQueuedMessage | null>;
  resume: () => void;
}

export interface ComposerToolbar {
  sessionId: string;
  /** The session's driver; models come from its catalog, and only its capabilities show controls. */
  provider?: AgentDriverId;
  capabilities?: AgentDriverCapabilities;
  /** The model and effort the next message uses; null means Codex's default. */
  modelId: string | null;
  effort: string | null;
  onModelChange: (model: CodexModelOption) => void;
  onEffortChange: (effort: string) => void;
  onNotify?: (message: string) => void;
}

const IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/u;
const MAX_ATTACHMENTS = 12;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** A paste longer than this goes out as a text file instead of filling the input. */
const LARGE_PASTE_CHARS = 20_000;
const FILE_SEARCH_DELAY_MS = 120;

const readBase64 = (file: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/u, ''));
  reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
  reader.readAsDataURL(file);
});
const formatSize = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.ceil(bytes / 1024)}KB`);

/** The driver's models and (Codex only) the session's skills, loaded once the composer can use them. */
function useComposerCatalog(sessionId: string | undefined, provider: AgentDriverId | undefined, capabilities: AgentDriverCapabilities) {
  const [models, setModels] = useState<CodexModelOption[]>([]);
  const [skills, setSkills] = useState<CodexSkillOption[] | null>(capabilities.skills ? null : []);
  const { models: listsModels, skills: hasSkills } = capabilities;
  useEffect(() => {
    if (!sessionId || !listsModels) return;
    let live = true;
    void codexCatalogClient.sessionModels(sessionId, provider).then((list) => live && setModels(list), () => {});
    return () => {
      live = false;
    };
  }, [sessionId, provider, listsModels]);
  const loadSkills = useMemo(() => () => {
    if (!sessionId) return;
    if (!hasSkills) return setSkills([]);
    void codexCatalogClient.skills(sessionId).then(setSkills, () => setSkills([]));
  }, [sessionId, hasSkills]);
  // A driver that started its process after the composer mounted lists its models only then.
  const reloadModels = useCallback(() => {
    if (!sessionId || !listsModels) return;
    void codexCatalogClient.sessionModels(sessionId, provider).then(setModels, () => {});
  }, [sessionId, provider, listsModels]);
  return { models, skills, loadSkills, reloadModels };
}

/** Floating input card with the approvals and questions that block the Worker stacked above it. */
export function SessionComposer(props: SessionComposerProps) {
  const { toolbar, slash, draftKey } = props;
  const [draft, setDraft] = useState(() => (draftKey ? composerDrafts.get(draftKey).text : ''));
  const [attached, setAttached] = useState<ComposerDraftAttachment[]>(() => (draftKey ? composerDrafts.get(draftKey).attachments : []));
  const [preparing, setPreparing] = useState(0);
  // Trigger state adapted from T3 Code `useComposerTriggerState.ts` (MIT): edits open suggestions
  // unless Escape dismissed the same trigger; caret moves only follow or close an open menu.
  const [trigger, setTriggerState] = useState<ComposerTrigger | null>(null);
  const activeTriggerRef = useRef<ComposerTrigger | null>(null);
  const dismissedTriggerRef = useRef<ComposerTrigger | null>(null);
  const [files, setFiles] = useState<CodexFileMatch[]>([]);
  const [fileSearching, setFileSearching] = useState(false);
  const [highlight, setHighlight] = useState<{ itemId: string | null; searchKey: string | null }>({ itemId: null, searchKey: null });
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchSeq = useRef(0);
  const capabilities = toolbar?.capabilities ?? CODEX_CAPABILITIES;
  const catalog = useComposerCatalog(toolbar?.sessionId, toolbar?.provider, capabilities);
  const choice = useMemo(
    () => resolveModelChoice(catalog.models, toolbar?.modelId ?? null, toolbar?.effort ?? null),
    [catalog.models, toolbar?.modelId, toolbar?.effort],
  );
  const imagesAllowed = Boolean(toolbar) && (choice.model?.images ?? true);

  const activateTrigger = useCallback((next: ComposerTrigger | null) => {
    activeTriggerRef.current = next;
    setTriggerState(next);
  }, []);

  const resetTrigger = useCallback((next: ComposerTrigger | null) => {
    dismissedTriggerRef.current = null;
    activateTrigger(next);
  }, [activateTrigger]);

  useImperativeHandle(props.handleRef, () => ({
    fill: (text: string) => {
      setDraft(text);
      resetTrigger(null);
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(text.length, text.length);
      });
    },
  }), [resetTrigger]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(COMPOSER_MAX_HEIGHT, el.scrollHeight)}px`;
  }, [draft, props.alive]);

  // The draft outlives this view; previews are released only when an attachment leaves the draft.
  const attachedRef = useRef(attached);
  attachedRef.current = attached;
  useEffect(() => {
    if (draftKey) composerDrafts.set(draftKey, { text: draft, attachments: attached });
  }, [draftKey, draft, attached]);

  useEffect(() => {
    if (!toolbar || trigger?.kind !== 'file' || !trigger.query) {
      setFiles([]);
      setFileSearching(false);
      return;
    }
    const seq = ++searchSeq.current;
    setFileSearching(true);
    const timer = setTimeout(() => {
      void window.vibeMeet?.agentSessions?.searchFiles({ id: toolbar.sessionId, query: trigger.query }).then((res) => {
        if (seq === searchSeq.current) {
          setFiles(res?.ok ? res.files : []);
          setFileSearching(false);
        }
      }, () => {
        if (seq === searchSeq.current) {
          setFiles([]);
          setFileSearching(false);
        }
      });
    }, FILE_SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [toolbar?.sessionId, trigger?.kind, trigger?.query]);

  const suggestions = useMemo<ComposerSuggestion[]>(() => {
    if (!trigger) return [];
    if (trigger.kind === 'slash') {
      if (!slash) return [];
      const isAtPromptStart = draft.slice(0, trigger.start).trim() === '';
      const hasTrailingText = draft.slice(trigger.end).trim() !== '';
      const canCompact =
        isAtPromptStart &&
        !hasTrailingText &&
        attached.length === 0 &&
        slash.hasTurns &&
        slash.canCompact !== false &&
        !props.running &&
        props.approvals.length === 0 &&
        !(props.directQuestions?.length);
      const items = buildSlashCommandItems({
        isAtPromptStart,
        hasTurns: slash.hasTurns,
        canCompact,
        hasUsageLimits: slash.hasUsageLimits,
        canHistory: slash.canHistory,
        canRename: slash.canRename,
        canOrchestration: slash.canOrchestration,
        orchestrationOn: slash.orchestrationOn,
        skills: catalog.skills ?? [],
        ...(slash.canGoal === false ? { canGoal: false } : {}),
        ...(slash.canFeedback === false ? { canFeedback: false } : {}),
        ...(slash.canModel === false ? { canModel: false } : {}),
      });
      return searchSlashCommandItems(items, trigger.query).map((item) => ({
        kind: 'slash' as const,
        id: item.id,
        item,
      }));
    }
    if (trigger.kind === 'skill') {
      return searchSkills(catalog.skills ?? [], trigger.query, 16).map((skill) => ({
        kind: 'skill' as const,
        id: `skill:${skill.path}`,
        skill,
        sourceKind: resolveSkillSourceKind(skill),
      }));
    }
    return files.map((file) => ({ kind: 'file' as const, id: `file:${file.path}`, file }));
  }, [trigger, slash, draft, attached.length, props.running, props.approvals.length, props.directQuestions?.length, catalog.skills, files]);

  const menuOpen = Boolean(trigger) && (
    (trigger!.kind === 'slash' && Boolean(slash)) ||
    trigger!.kind === 'skill' ||
    (trigger!.kind === 'file' && Boolean(trigger!.query))
  );
  const menuLoading =
    ((trigger?.kind === 'skill' || trigger?.kind === 'slash') && !catalog.skills) ||
    (trigger?.kind === 'file' && fileSearching);
  const searchKey = trigger ? `${trigger.kind}:${trigger.query.trim().toLowerCase()}` : null;
  const activeItemId = resolveMenuActiveItemId({
    items: suggestions,
    highlightedItemId: highlight.itemId,
    currentSearchKey: searchKey,
    highlightedSearchKey: highlight.searchKey,
  });
  const activeSuggestion = suggestions.find((item) => item.id === activeItemId) ?? suggestions[0] ?? null;
  const onHighlightItem = useCallback((itemId: string) => {
    setHighlight({ itemId, searchKey });
  }, [searchKey]);

  const localSlashCommand = Boolean(slash) && runsSlashCommandLocally({
    text: draft,
    holdsOnlyText: attached.length === 0,
    hasTurns: Boolean(slash?.hasTurns),
    hasUsageLimits: Boolean(slash?.hasUsageLimits),
    canHistory: Boolean(slash?.canHistory),
    canRename: Boolean(slash?.canRename),
    canOrchestration: Boolean(slash?.canOrchestration),
    canGoal: slash?.canGoal !== false,
    canFeedback: slash?.canFeedback !== false,
    canModel: slash?.canModel !== false,
  });

  const { queue } = props;
  const queueing = Boolean(queue && props.running && !localSlashCommand);
  const blocked = Boolean(props.direct && props.running && !queue && !localSlashCommand);
  const placeholder = props.direct
    ? (queueing ? '正在工作，现在发送会排队，本轮结束后自动发出' : props.running ? '正在工作，可以先写好下一条' : props.resumable ? '发送消息会恢复这个会话' : toolbar ? `给助手发消息，/ 斜杠命令，${capabilities.skills ? '$ 选技能，' : ''}@ 引用文件` : '给助手发消息')
    : (props.running ? '补充指令，本轮结束后送达' : '给 Worker 发送追加指令');

  const handleEditTrigger = (text: string, caret: number) => {
    if (!toolbar) return;
    const candidate = detectTrigger(text, caret);
    const allowed = (candidate?.kind === 'slash' && !slash) || (candidate?.kind === 'skill' && !capabilities.skills) ? null : candidate;
    if (isSameTrigger(dismissedTriggerRef.current, allowed)) {
      activateTrigger(null);
      return;
    }
    dismissedTriggerRef.current = null;
    activateTrigger(allowed);
    if ((allowed?.kind === 'skill' || allowed?.kind === 'slash') && !catalog.skills) catalog.loadSkills();
  };

  const handleSelectTrigger = (text: string, caret: number) => {
    if (!toolbar) return;
    const candidate = detectTrigger(text, caret);
    const allowed = (candidate?.kind === 'slash' && !slash) || (candidate?.kind === 'skill' && !capabilities.skills) ? null : candidate;
    if (!isSameTrigger(dismissedTriggerRef.current, allowed)) {
      dismissedTriggerRef.current = null;
    }
    activateTrigger(isSameTrigger(activeTriggerRef.current, allowed) ? allowed : null);
  };

  const openModelPicker = useCallback(() => {
    if (props.running) {
      toolbar?.onNotify?.('本轮结束后可以切换模型');
      return;
    }
    if (catalog.models.length === 0) {
      toolbar?.onNotify?.('正在读取模型列表，请稍后再试');
      return;
    }
    setModelPickerOpen(true);
  }, [props.running, catalog.models.length, toolbar]);

  const replaceTrigger = (insertion: string) => {
    if (!trigger) return;
    const next = applyCompletion(draft, trigger, insertion);
    setDraft(next.text);
    resetTrigger(null);
    setHighlight({ itemId: null, searchKey: null });
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const stripTrigger = (focusAfter = true) => {
    if (!trigger) return;
    const next = removeTriggerRange(draft, trigger);
    setDraft(next.text);
    resetTrigger(null);
    setHighlight({ itemId: null, searchKey: null });
    if (focusAfter) {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(next.caret, next.caret);
      });
    }
  };

  const choose = useCallback((item: ComposerSuggestion) => {
    if (item.kind === 'file') {
      replaceTrigger(fileMention(item.file.path));
      return;
    }
    if (item.kind === 'skill') {
      replaceTrigger(skillMention(item.skill.name));
      return;
    }
    const cmd = item.item;
    if (cmd.type === 'skill') {
      replaceTrigger(skillMention(cmd.skill.name));
      return;
    }
    if (cmd.type === 'builtin') {
      if (cmd.command === 'model') {
        stripTrigger(false);
        openModelPicker();
        return;
      }
      if (cmd.command === 'clear') {
        stripTrigger(true);
        slash?.onArmFreshSession();
        return;
      }
      if (cmd.command === 'history') {
        stripTrigger(false);
        slash?.onOpenHistory();
        return;
      }
      if (cmd.command === 'rename') {
        replaceTrigger('/rename');
        return;
      }
      if (cmd.command === 'orchestration') {
        stripTrigger(true);
        slash?.onSetOrchestration('toggle');
        return;
      }
      return;
    }
    if (cmd.command === 'usage-limits') {
      stripTrigger(false);
      slash?.onOpenUsageLimits();
      return;
    }
    replaceTrigger(`/${cmd.command}`);
  }, [draft, trigger, slash, openModelPicker]);

  const useSkill = (skill: CodexSkillOption) => {
    const el = inputRef.current;
    const caret = el?.selectionStart ?? draft.length;
    const before = draft.slice(0, caret);
    const token = `${before && !/\s$/u.test(before) ? ' ' : ''}${skillMention(skill.name)} `;
    setDraft(before + token + draft.slice(caret));
    catalog.loadSkills();
    requestAnimationFrame(() => el?.focus());
  };

  /**
   * Images are scaled down and re-encoded to fit before they are saved; when the model cannot see
   * images they go as plain files, which the agent can still open by path. Other files are saved as is.
   */
  const addFiles = async (list: readonly File[]) => {
    if (!toolbar) return;
    const api = window.vibeMeet?.agentSessions;
    if (!api?.attachImage || !api.attachFile) return;
    const room = MAX_ATTACHMENTS - attachedRef.current.length;
    if (list.length > room) toolbar.onNotify?.(`一条消息最多 ${MAX_ATTACHMENTS} 个附件`);
    const accepted = list.slice(0, Math.max(0, room));
    setPreparing((count) => count + accepted.length);
    for (const source of accepted) {
      try {
        const image = IMAGE_MIME.test(source.type) && imagesAllowed;
        if (image) {
          const prepared = await prepareImageForAttachment(source, MAX_IMAGE_BYTES);
          if (!prepared.ok) {
            toolbar.onNotify?.(prepared.reason === 'too-large' ? `「${source.name}」太大，压缩后仍超过 10MB` : `「${source.name}」无法作为图片读取`);
            continue;
          }
          const file = prepared.file;
          const res = await api.attachImage({ id: toolbar.sessionId, name: file.name || 'image.png', mime: file.type, data: await readBase64(file) });
          if (!res.ok) {
            toolbar.onNotify?.(res.error);
            continue;
          }
          setAttached((current) => [...current, {
            key: res.attachment.path, kind: 'image', name: res.attachment.name ?? file.name, previewUrl: URL.createObjectURL(file), attachment: res.attachment,
          }]);
          continue;
        }
        if (source.size > MAX_FILE_BYTES) {
          toolbar.onNotify?.(`「${source.name}」有 ${formatSize(source.size)}，文件不能超过 20MB`);
          continue;
        }
        const res = await api.attachFile({ id: toolbar.sessionId, name: source.name || 'file', data: await readBase64(source) });
        if (!res.ok) {
          toolbar.onNotify?.(res.error);
          continue;
        }
        setAttached((current) => [...current, {
          key: res.attachment.path, kind: 'file', name: res.attachment.name ?? source.name, previewUrl: null, attachment: res.attachment,
        }]);
      } catch (error) {
        toolbar.onNotify?.(error instanceof Error ? error.message : '添加附件失败');
      } finally {
        setPreparing((count) => count - 1);
      }
    }
  };
  const removeAttachment = (key: string) => setAttached((current) => current.filter((item) => {
    if (item.key === key && item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    return item.key !== key;
  }));

  const clearDraft = () => {
    setDraft('');
    resetTrigger(null);
    setHighlight({ itemId: null, searchKey: null });
    attached.forEach((item) => item.previewUrl && URL.revokeObjectURL(item.previewUrl));
    setAttached([]);
  };

  const send = async () => {
    const text = draft.trim();
    if ((!text && attached.length === 0) || props.sending || blocked || preparing > 0) return;
    if (slash && attached.length === 0 && text) {
      if (isModelCommand(text)) {
        clearDraft();
        openModelPicker();
        return;
      }
      if (isClearCommand(text)) {
        if (!slash.hasTurns) {
          toolbar?.onNotify?.('当前还没有历史对话，无需开启新上下文');
          return;
        }
        clearDraft();
        slash.onArmFreshSession();
        return;
      }
      if (isUsageLimitsCommand(text)) {
        clearDraft();
        slash.onOpenUsageLimits();
        return;
      }
      if (isHistoryCommand(text)) {
        if (!slash.canHistory) {
          toolbar?.onNotify?.('当前会话不支持历史记录');
          return;
        }
        clearDraft();
        slash.onOpenHistory();
        return;
      }
      const renameCmd = parseRenameCommand(text);
      if (renameCmd) {
        if (!slash.canRename) return;
        if (!renameCmd.title) {
          toolbar?.onNotify?.('请输入新标题，例如 /rename 登录重构');
          return;
        }
        const edit = resolveTitleEdit(renameCmd.title, slash.currentTitle);
        if (edit.action === 'reject') {
          toolbar?.onNotify?.(edit.error);
          return;
        }
        if (edit.action === 'noop') {
          clearDraft();
          toolbar?.onNotify?.('标题没有变化');
          return;
        }
        if (await slash.onRename(edit.title)) {
          clearDraft();
          toolbar?.onNotify?.(`已改名为「${edit.title}」`);
        }
        return;
      }
      const orchCmd = parseOrchestrationCommand(text);
      if (orchCmd && slash.canOrchestration) {
        clearDraft();
        slash.onSetOrchestration(orchCmd.mode);
        return;
      }
      const feedbackCmd = parseFeedbackCommand(text);
      if (feedbackCmd) {
        if (!slash.hasTurns) {
          toolbar?.onNotify?.('请先发送至少一条消息后再提交反馈');
          return;
        }
        clearDraft();
        slash.onFeedbackCommand(feedbackCmd.reason);
        return;
      }
      const goalCmd = parseGoalCommand(text, attached.length);
      if (goalCmd) {
        if (await slash.onGoalCommand(goalCmd)) clearDraft();
        return;
      }
      if (isCompactCommand(text) && !slash.hasTurns) {
        toolbar?.onNotify?.('还没有可压缩的对话记录');
        return;
      }
    }
    const skills = skillsInText(text, catalog.skills ?? []);
    const attachments: AgentTurnAttachment[] = [
      ...skills.map((skill) => ({ type: 'skill' as const, name: skill.name, path: skill.path })),
      ...attached.map((item) => item.attachment),
    ];
    const freshContext = Boolean(slash?.freshSessionArmed);
    if (await props.onSend(text, attachments, freshContext ? { freshContext: true } : undefined)) {
      clearDraft();
      if (freshContext) slash?.onDisarmFreshSession();
    }
  };

  const [queueBusy, setQueueBusy] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const takeQueued = useCallback(async (id: string, edit: boolean) => {
    if (!queue) return;
    if (edit && (draftRef.current.trim() || attachedRef.current.length)) {
      toolbar?.onNotify?.('输入框里还有内容，先发送或清空后再取回');
      return;
    }
    setQueueBusy(true);
    const message = await queue.take(id).finally(() => setQueueBusy(false));
    if (!message || !edit) return;
    setDraft(message.text);
    if (message.freshContext) slash?.onArmFreshSession();
    setAttached(message.attachments.flatMap((attachment): ComposerDraftAttachment[] => attachment.type === 'skill' ? [] : [{
      key: attachment.path, kind: attachment.type === 'localImage' ? 'image' : 'file',
      name: attachment.name ?? attachment.path.split(/[\\/]/u).pop() ?? '附件', previewUrl: null, attachment,
    }]));
    requestAnimationFrame(() => {
      const el = inputRef.current;
      el?.focus();
      el?.setSelectionRange(message.text.length, message.text.length);
    });
  }, [queue, toolbar, slash]);
  const editQueued = useCallback((id: string) => void takeQueued(id, true), [takeQueued]);
  const removeQueued = useCallback((id: string) => void takeQueued(id, false), [takeQueued]);

  // A `$` or `/` typed before the skills loaded still finds them once they arrive.
  const { skills: loadedSkills, loadSkills } = catalog;
  const hasToolbar = Boolean(toolbar);
  useEffect(() => {
    if (hasToolbar && /(^|\s)[$/]/u.test(draft) && !loadedSkills) loadSkills();
  }, [hasToolbar, draft, loadedSkills, loadSkills]);

  const hasSlashBanners = Boolean(
    slash && (slash.freshSessionArmed || slash.usageLimitsOpen || slash.goal || slash.feedback),
  );
  const hasBannerLane =
    props.approvals.length > 0 || props.questions.length > 0 || Boolean(props.directQuestions?.length) || hasSlashBanners;
  const hasEndedStrip = !props.alive && Boolean(
    props.branch || (!props.direct && props.readOnly !== undefined) || props.readOnly || props.usageLimits || props.usage,
  );

  return (
    <div className="asv-dock-inner">
      {hasBannerLane && (
        <div className="asv-banner-lane">
          {props.approvals.map((item) => <ApprovalBanner key={item.id} item={item} />)}
          {props.questions.map((question) => <QuestionBanner key={question.messageId} question={question} />)}
          {props.onAnswer && props.directQuestions?.map((entry) => (
            <DirectQuestionBanner key={entry.requestId} entry={entry} onAnswer={props.onAnswer!} />
          ))}
          {slash?.goal && (
            <GoalBanner
              goal={slash.goal}
              running={props.running}
              busy={slash.goalBusy}
              onPause={() => void slash.onGoalCommand({ type: 'pause' })}
              onResume={() => void slash.onGoalCommand({ type: 'resume' })}
              onClear={() => void slash.onGoalCommand({ type: 'clear' })}
            />
          )}
          {slash?.usageLimitsOpen && (
            <UsageLimitsBanner
              summary={props.usageLimits ?? null}
              refreshing={slash.usageLimitsRefreshing}
              onRefresh={slash.onRefreshUsageLimits}
              onClose={slash.onCloseUsageLimits}
            />
          )}
          {slash?.feedback && (
            <FeedbackBanner state={slash.feedback} onDismiss={slash.onDismissFeedback} />
          )}
          {slash?.freshSessionArmed && (
            <FreshSessionBanner onDismiss={slash.onDisarmFreshSession} />
          )}
        </div>
      )}
      {queue && (
        <SessionQueue
          queued={queue.items}
          paused={queue.paused}
          busy={queueBusy}
          onEdit={editQueued}
          onRemove={removeQueued}
          onResume={queue.resume}
        />
      )}
      {props.alive ? (
        <div
          className={`asv-composer${dragging ? ' is-dragging' : ''}`}
          onDragOver={(event) => {
            if (!toolbar || !event.dataTransfer.types.includes('Files')) return;
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            setDragging(false);
            const dropped = [...event.dataTransfer.files];
            if (!toolbar || dropped.length === 0) return;
            event.preventDefault();
            void addFiles(dropped);
          }}
        >
          {menuOpen && trigger && (
            <ComposerCommandMenu
              triggerKind={trigger.kind}
              items={suggestions}
              activeItemId={activeItemId}
              loading={menuLoading}
              onHighlight={onHighlightItem}
              onSelect={choose}
            />
          )}
          {(attached.length > 0 || preparing > 0) && (
            <div className="asv-attach-strip">
              {attached.map((item) => item.kind === 'image' && item.previewUrl ? (
                <div key={item.key} className="asv-attach-thumb" title={item.name}>
                  <img src={item.previewUrl} alt={item.name} />
                  <button type="button" aria-label={`移除 ${item.name}`} onClick={() => removeAttachment(item.key)}>
                    <X size={11} />
                  </button>
                </div>
              ) : (
                <div key={item.key} className="asv-attach-file" title={item.name}>
                  <FileText size={14} aria-hidden="true" />
                  <span>{item.name}</span>
                  <button type="button" aria-label={`移除 ${item.name}`} onClick={() => removeAttachment(item.key)}>
                    <X size={11} />
                  </button>
                </div>
              ))}
              {preparing > 0 && (
                <div className="asv-attach-thumb is-preparing" aria-label="正在处理附件">
                  <Loader2 size={16} className="asv-spin" aria-hidden="true" />
                </div>
              )}
            </div>
          )}
          <textarea
            ref={inputRef}
            className="asv-composer-input"
            placeholder={placeholder}
            value={draft}
            rows={1}
            onChange={(event) => {
              setDraft(event.target.value);
              handleEditTrigger(event.target.value, event.target.selectionStart ?? event.target.value.length);
            }}
            onSelect={(event) => handleSelectTrigger(event.currentTarget.value, event.currentTarget.selectionStart ?? 0)}
            onBlur={() => activateTrigger(null)}
            onPaste={(event) => {
              if (!toolbar) return;
              const pasted = [...event.clipboardData.files];
              if (pasted.length > 0) {
                event.preventDefault();
                void addFiles(pasted);
                return;
              }
              const text = event.clipboardData.getData('text/plain');
              if (text.length > LARGE_PASTE_CHARS) {
                event.preventDefault();
                void addFiles([new File([text], 'pasted-text.txt', { type: 'text/plain' })]);
                toolbar.onNotify?.(`粘贴内容较长（${text.length} 字），已作为 pasted-text.txt 附加`);
              }
            }}
            onKeyDown={(event) => {
              if (menuOpen && event.key === 'Escape' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                dismissedTriggerRef.current = trigger;
                activateTrigger(null);
                return;
              }
              if (menuOpen && suggestions.length > 0 && !event.shiftKey) {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  const step = event.key === 'ArrowDown' ? 1 : -1;
                  const currentIndex = Math.max(0, suggestions.findIndex((item) => item.id === activeItemId));
                  const next = suggestions[(currentIndex + step + suggestions.length) % suggestions.length]!;
                  setHighlight({ itemId: next.id, searchKey });
                  return;
                }
                if ((event.key === 'Enter' || event.key === 'Tab') && !event.nativeEvent.isComposing && activeSuggestion) {
                  event.preventDefault();
                  choose(activeSuggestion);
                  return;
                }
              }
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
            aria-label={props.direct ? '消息' : '追加指令'}
          />
          <div className="asv-composer-bar">
            {toolbar ? (
              <div className="asv-composer-tools">
                <button
                  type="button"
                  className="asv-tool-btn is-icon"
                  aria-label="添加附件"
                  title={imagesAllowed ? '添加图片或文件（也可以粘贴或拖入）' : '添加文件（当前模型不支持图片，图片会作为文件附加）'}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Paperclip size={14} />
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(event) => {
                    void addFiles([...(event.target.files ?? [])]);
                    event.target.value = '';
                  }}
                />
                {capabilities.plugins && (
                  <ComposerCatalogPanel sessionId={toolbar.sessionId} onNotify={toolbar.onNotify} onUseSkill={useSkill} />
                )}
                {capabilities.models && (
                  <ComposerModelPicker
                    models={catalog.models}
                    model={choice.model}
                    fallbackLabel={toolbar.modelId}
                    effort={capabilities.efforts ? choice.effort : null}
                    disabled={props.running}
                    open={modelPickerOpen}
                    onOpenChange={(open) => {
                      if (open) catalog.reloadModels();
                      setModelPickerOpen(open);
                    }}
                    onModelChange={toolbar.onModelChange}
                    onEffortChange={toolbar.onEffortChange}
                  />
                )}
              </div>
            ) : (
              <span className="asv-composer-hint">Enter 发送 · Shift+Enter 换行</span>
            )}
            <div className="asv-composer-actions">
              {props.branch && <Chip icon={<GitBranch size={12} />} title={props.branch}>{props.branch}</Chip>}
              {props.policy && props.onPolicyChange ? (
                <label className="asv-chip asv-policy asv-composer-ctrl" title="权限：下一条消息起生效">
                  <Lock size={12} aria-hidden="true" />
                  <select
                    value={props.policy}
                    disabled={props.running}
                    aria-label="权限"
                    onChange={(event) => props.onPolicyChange!(event.target.value as AgentSessionPolicy)}
                  >
                    {(toolbar ? capabilities.policies : Object.keys(POLICY_LABELS) as AgentSessionPolicy[]).map((value) => (
                      <option key={value} value={value}>{POLICY_LABELS[value]}</option>
                    ))}
                  </select>
                  <ChevronDown size={11} className="asv-policy-caret" aria-hidden="true" />
                </label>
              ) : !props.direct && props.readOnly !== undefined ? (
                <Chip icon={<Lock size={12} />}>{props.readOnly ? POLICY_LABELS['read-only'] : POLICY_LABELS['workspace-write']}</Chip>
              ) : props.readOnly && <Chip icon={<Lock size={12} />}>{POLICY_LABELS['read-only']}</Chip>}
              {props.onNetworkChange && (
                <button
                  type="button"
                  className={`asv-chip asv-chip-toggle asv-composer-ctrl${props.network ? ' is-on' : ''}`}
                  disabled={props.running}
                  aria-pressed={Boolean(props.network)}
                  title={props.network ? '命令可以联网：下一条消息起生效' : '命令不能联网（npm install 等会失败）：下一条消息起生效'}
                  onClick={() => props.onNetworkChange!(!props.network)}
                >
                  <Globe size={12} aria-hidden="true" />
                  <span>{props.network ? '联网' : '不联网'}</span>
                </button>
              )}
              {props.usageLimits && <UsageLimitChip summary={props.usageLimits} />}
              {props.usage && (
                <span className="asv-chip asv-composer-usage" title={`输入 ${props.usage.input} · 输出 ${props.usage.output}`}>
                  {formatTokenCount(props.usage.total)} tokens
                </span>
              )}
              <div className="asv-composer-submit">
                {props.running && (
                  <button type="button" className="asv-round-btn" disabled={props.interrupting} onClick={props.onInterrupt} aria-label="中断本轮" title="中断本轮">
                    <Square size={12} fill="currentColor" />
                  </button>
                )}
                <button
                  type="button"
                  className="asv-round-btn is-primary"
                  disabled={(!draft.trim() && attached.length === 0) || props.sending || blocked || preparing > 0}
                  onClick={() => void send()}
                  aria-label={localSlashCommand ? '执行命令' : queueing ? '加入队列' : '发送'}
                  title={localSlashCommand ? '执行斜杠命令（Enter）' : queueing ? '加入队列，本轮结束后发送（Enter）' : '发送（Enter）· Shift+Enter 换行'}
                >
                  <ArrowUp size={16} strokeWidth={2.25} />
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="asv-composer is-ended">{props.endedText ?? '会话已结束，当前为只读回放'}</div>
      )}
      {hasEndedStrip && (
        <div className="asv-context-strip">
          {props.branch && <Chip icon={<GitBranch size={12} />} title={props.branch}>{props.branch}</Chip>}
          {!props.direct && props.readOnly !== undefined ? (
            <Chip icon={<Lock size={12} />}>{props.readOnly ? POLICY_LABELS['read-only'] : POLICY_LABELS['workspace-write']}</Chip>
          ) : props.readOnly && <Chip icon={<Lock size={12} />}>{POLICY_LABELS['read-only']}</Chip>}
          <span className="asv-strip-spacer" />
          {props.usageLimits && <UsageLimitChip summary={props.usageLimits} />}
          {props.usage && (
            <span className="asv-chip" title={`输入 ${props.usage.input} · 输出 ${props.usage.output}`}>
              {formatTokenCount(props.usage.total)} tokens
            </span>
          )}
        </div>
      )}
    </div>
  );
}
