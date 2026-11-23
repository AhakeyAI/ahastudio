import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import {
  ArrowUp, Cpu, FileText, Folder, GitBranch, Globe, Loader2, Lock, MessageCircleQuestion, Paperclip, ShieldAlert, Sparkles, Square, X,
} from 'lucide-react';
import { composerDrafts, type ComposerDraftAttachment } from '../../lib/composer-drafts';
import { prepareImageForAttachment } from '../../lib/image-compression';
import { formatTokenCount } from '../../lib/worker-timeline-model';
import { POLICY_LABELS, codexCatalogClient } from '../../lib/agent-session-client';
import {
  applyCompletion, detectTrigger, fileMention, filterSkills, resolveModelChoice, skillMention, skillsInText,
  type ComposerTrigger,
} from '../../lib/composer-tokens';
import type {
  AgentSessionInfo, AgentSessionPolicy, AgentTurnAttachment, CodexFileMatch, CodexModelOption, CodexSkillOption,
  OrchestrationQuestionRecord, WorkerTimelineItem,
} from '../../types';
import { ComposerCatalogPanel } from './ComposerCatalogPanel';
import { ComposerModelPicker } from './ComposerModelPicker';
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

const baseName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;

export interface SessionComposerProps {
  alive: boolean;
  running: boolean;
  sending: boolean;
  interrupting: boolean;
  approvals: readonly ApprovalItem[];
  questions: readonly OrchestrationQuestionRecord[];
  cwd: string | null;
  branch: string | null;
  model: string | null;
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
  /** Direct sessions take one turn at a time, so sending waits for the running turn. */
  direct?: boolean;
  usage: { input: number; output: number; total: number } | null;
  /** Direct sessions: model and effort, `$` skills, `@` files, attachments, and the plugin panel. */
  toolbar?: ComposerToolbar;
  /** Keeps the unsent draft across tab switches (and its text across restarts) under this key. */
  draftKey?: string;
  /** Resolves true once the message was accepted, which clears the draft. */
  onSend: (text: string, attachments: AgentTurnAttachment[]) => Promise<boolean>;
  onInterrupt: () => void;
  handleRef?: Ref<ComposerHandle>;
}

export interface ComposerHandle {
  /** Replaces the draft text and focuses the input with the caret at the end; nothing is sent. */
  fill: (text: string) => void;
}

export interface ComposerToolbar {
  sessionId: string;
  /** The model and effort the next message uses; null means Codex's default. */
  modelId: string | null;
  effort: string | null;
  onModelChange: (model: CodexModelOption) => void;
  onEffortChange: (effort: string) => void;
  onNotify?: (message: string) => void;
}

type Suggestion =
  | { kind: 'skill'; key: string; skill: CodexSkillOption }
  | { kind: 'file'; key: string; file: CodexFileMatch };

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

/** Codex's models and the session's skills, loaded once the composer can use them. */
function useComposerCatalog(sessionId: string | undefined) {
  const [models, setModels] = useState<CodexModelOption[]>([]);
  const [skills, setSkills] = useState<CodexSkillOption[] | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    void codexCatalogClient.models().then((list) => live && setModels(list), () => {});
    return () => {
      live = false;
    };
  }, [sessionId]);
  const loadSkills = useMemo(() => () => {
    if (!sessionId) return;
    void codexCatalogClient.skills(sessionId).then(setSkills, () => setSkills([]));
  }, [sessionId]);
  return { models, skills, loadSkills };
}

/** Floating input card with the approvals and questions that block the Worker stacked above it. */
export function SessionComposer(props: SessionComposerProps) {
  const { toolbar, draftKey } = props;
  const [draft, setDraft] = useState(() => (draftKey ? composerDrafts.get(draftKey).text : ''));
  const [attached, setAttached] = useState<ComposerDraftAttachment[]>(() => (draftKey ? composerDrafts.get(draftKey).attachments : []));
  const [preparing, setPreparing] = useState(0);
  const [trigger, setTrigger] = useState<ComposerTrigger | null>(null);
  const [files, setFiles] = useState<CodexFileMatch[]>([]);
  const [active, setActive] = useState(0);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchSeq = useRef(0);
  const catalog = useComposerCatalog(toolbar?.sessionId);
  const choice = useMemo(
    () => resolveModelChoice(catalog.models, toolbar?.modelId ?? null, toolbar?.effort ?? null),
    [catalog.models, toolbar?.modelId, toolbar?.effort],
  );
  const imagesAllowed = Boolean(toolbar) && (choice.model?.images ?? true);

  useImperativeHandle(props.handleRef, () => ({
    fill: (text: string) => {
      setDraft(text);
      setTrigger(null);
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(text.length, text.length);
      });
    },
  }), []);

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
      return;
    }
    const seq = ++searchSeq.current;
    const timer = setTimeout(() => {
      void window.vibeMeet?.agentSessions?.searchFiles({ id: toolbar.sessionId, query: trigger.query }).then((res) => {
        if (seq === searchSeq.current) setFiles(res?.ok ? res.files : []);
      });
    }, FILE_SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [toolbar?.sessionId, trigger?.kind, trigger?.query]);

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!trigger) return [];
    if (trigger.kind === 'skill') {
      return filterSkills(catalog.skills ?? [], trigger.query, 12)
        .map((skill) => ({ kind: 'skill' as const, key: skill.path, skill }));
    }
    return files.map((file) => ({ kind: 'file' as const, key: file.path, file }));
  }, [trigger, catalog.skills, files]);
  const menuOpen = Boolean(trigger) && (suggestions.length > 0 || (trigger?.kind === 'skill' && !catalog.skills));

  const blocked = Boolean(props.direct && props.running);
  const placeholder = props.direct
    ? (props.running ? '正在工作，可以先写好下一条' : props.resumable ? '发送消息会恢复这个会话' : toolbar ? '给 Codex 发消息，$ 选技能，@ 引用文件' : '给 Codex 发消息')
    : (props.running ? '补充指令，本轮结束后送达' : '给 Worker 发送追加指令');

  const updateTrigger = (text: string, caret: number) => {
    if (!toolbar) return;
    const next = detectTrigger(text, caret);
    setTrigger(next);
    setActive(0);
    if (next?.kind === 'skill' && !catalog.skills) catalog.loadSkills();
  };

  const insert = (insertion: string) => {
    if (!trigger) return;
    const next = applyCompletion(draft, trigger, insertion);
    setDraft(next.text);
    setTrigger(null);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };
  const choose = (item: Suggestion) => insert(item.kind === 'skill' ? skillMention(item.skill.name) : fileMention(item.file.path));

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

  const send = async () => {
    const text = draft.trim();
    if ((!text && attached.length === 0) || props.sending || blocked || preparing > 0) return;
    const skills = skillsInText(text, catalog.skills ?? []);
    const attachments: AgentTurnAttachment[] = [
      ...skills.map((skill) => ({ type: 'skill' as const, name: skill.name, path: skill.path })),
      ...attached.map((item) => item.attachment),
    ];
    if (await props.onSend(text, attachments)) {
      setDraft('');
      setTrigger(null);
      attached.forEach((item) => item.previewUrl && URL.revokeObjectURL(item.previewUrl));
      setAttached([]);
    }
  };

  // A `$` typed before the skills loaded still finds them once they arrive.
  const { skills: loadedSkills, loadSkills } = catalog;
  const hasToolbar = Boolean(toolbar);
  useEffect(() => {
    if (hasToolbar && /(^|\s)\$/u.test(draft) && !loadedSkills) loadSkills();
  }, [hasToolbar, draft, loadedSkills, loadSkills]);

  return (
    <div className="asv-dock-inner">
      {(props.approvals.length > 0 || props.questions.length > 0 || Boolean(props.directQuestions?.length)) && (
        <div className="asv-banner-lane">
          {props.approvals.map((item) => <ApprovalBanner key={item.id} item={item} />)}
          {props.questions.map((question) => <QuestionBanner key={question.messageId} question={question} />)}
          {props.onAnswer && props.directQuestions?.map((entry) => (
            <DirectQuestionBanner key={entry.requestId} entry={entry} onAnswer={props.onAnswer!} />
          ))}
        </div>
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
          {menuOpen && (
            <div className="asv-suggest" role="listbox" aria-label={trigger?.kind === 'skill' ? '技能' : '文件'}>
              <div className="asv-suggest-head">{trigger?.kind === 'skill' ? '技能' : '文件'}</div>
              {trigger?.kind === 'skill' && !catalog.skills && <div className="asv-pop-note">正在读取技能…</div>}
              {suggestions.map((item, index) => (
                <button
                  key={item.key}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  className={`asv-suggest-row${index === active ? ' is-active' : ''}`}
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(item)}
                >
                  {item.kind === 'skill' ? <Sparkles size={13} aria-hidden="true" /> : <FileText size={13} aria-hidden="true" />}
                  <span className="asv-suggest-title">{item.kind === 'skill' ? item.skill.name : item.file.fileName}</span>
                  <span className="asv-suggest-desc">{item.kind === 'skill' ? item.skill.description : item.file.path}</span>
                </button>
              ))}
            </div>
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
              updateTrigger(event.target.value, event.target.selectionStart ?? event.target.value.length);
            }}
            onSelect={(event) => updateTrigger(event.currentTarget.value, event.currentTarget.selectionStart ?? 0)}
            onBlur={() => setTrigger(null)}
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
              if (menuOpen && suggestions.length > 0) {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  const step = event.key === 'ArrowDown' ? 1 : -1;
                  setActive((index) => (index + step + suggestions.length) % suggestions.length);
                  return;
                }
                if ((event.key === 'Enter' || event.key === 'Tab') && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  choose(suggestions[active] ?? suggestions[0]!);
                  return;
                }
              }
              if (menuOpen && event.key === 'Escape') {
                event.preventDefault();
                setTrigger(null);
                return;
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
                <ComposerCatalogPanel sessionId={toolbar.sessionId} onNotify={toolbar.onNotify} onUseSkill={useSkill} />
                <ComposerModelPicker
                  models={catalog.models}
                  model={choice.model}
                  fallbackLabel={toolbar.modelId}
                  effort={choice.effort}
                  disabled={props.running}
                  onModelChange={toolbar.onModelChange}
                  onEffortChange={toolbar.onEffortChange}
                />
              </div>
            ) : (
              <span className="asv-composer-hint">Enter 发送 · Shift+Enter 换行</span>
            )}
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
              aria-label="发送"
              title="发送（Enter）· Shift+Enter 换行"
            >
              <ArrowUp size={15} strokeWidth={2.25} />
            </button>
          </div>
        </div>
      ) : (
        <div className="asv-composer is-ended">会话已结束，当前为只读回放</div>
      )}
      <div className="asv-context-strip">
        {props.cwd && <Chip icon={<Folder size={12} />} title={props.cwd}>{baseName(props.cwd)}</Chip>}
        {props.branch && <Chip icon={<GitBranch size={12} />} title={props.branch}>{props.branch}</Chip>}
        {props.model && !toolbar && <Chip icon={<Cpu size={12} />}>{props.model}</Chip>}
        {props.policy && props.onPolicyChange ? (
          <label className="asv-chip asv-policy" title="权限：下一条消息起生效">
            <Lock size={12} />
            <select value={props.policy} disabled={props.running} aria-label="权限"
              onChange={(event) => props.onPolicyChange!(event.target.value as AgentSessionPolicy)}>
              {(Object.keys(POLICY_LABELS) as AgentSessionPolicy[]).map((value) => (
                <option key={value} value={value}>{POLICY_LABELS[value]}</option>
              ))}
            </select>
          </label>
        ) : !props.direct && props.readOnly !== undefined ? (
          <Chip icon={<Lock size={12} />}>{props.readOnly ? POLICY_LABELS['read-only'] : POLICY_LABELS['workspace-write']}</Chip>
        ) : props.readOnly && <Chip icon={<Lock size={12} />}>{POLICY_LABELS['read-only']}</Chip>}
        {props.onNetworkChange && (
          <button type="button" className={`asv-chip asv-chip-toggle${props.network ? ' is-on' : ''}`}
            disabled={props.running} aria-pressed={Boolean(props.network)}
            title={props.network ? '命令可以联网：下一条消息起生效' : '命令不能联网（npm install 等会失败）：下一条消息起生效'}
            onClick={() => props.onNetworkChange!(!props.network)}>
            <Globe size={12} />
            <span>{props.network ? '联网' : '不联网'}</span>
          </button>
        )}
        <span className="asv-strip-spacer" />
        {props.usage && (
          <span className="asv-chip" title={`输入 ${props.usage.input} · 输出 ${props.usage.output}`}>
            {formatTokenCount(props.usage.total)} tokens
          </span>
        )}
      </div>
    </div>
  );
}
