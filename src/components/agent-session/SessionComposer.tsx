import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, Cpu, Folder, GitBranch, Globe, Lock, MessageCircleQuestion, ShieldAlert, Square } from 'lucide-react';
import { formatTokenCount } from '../../lib/worker-timeline-model';
import { POLICY_LABELS } from '../../lib/agent-session-client';
import type { AgentSessionInfo, AgentSessionPolicy, OrchestrationQuestionRecord, WorkerTimelineItem } from '../../types';
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
  readOnly: boolean;
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
  /** Resolves true once the message was accepted, which clears the draft. */
  onSend: (text: string) => Promise<boolean>;
  onInterrupt: () => void;
}

/** Floating input card with the approvals and questions that block the Worker stacked above it. */
export function SessionComposer(props: SessionComposerProps) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(COMPOSER_MAX_HEIGHT, el.scrollHeight)}px`;
  }, [draft, props.alive]);

  const blocked = Boolean(props.direct && props.running);
  const placeholder = props.direct
    ? (props.running ? '正在工作，可以先写好下一条' : props.resumable ? '发送消息会恢复这个会话' : '给 Codex 发消息')
    : (props.running ? '补充指令，本轮结束后送达' : '给 Worker 发送追加指令');

  const send = async () => {
    const text = draft.trim();
    if (!text || props.sending || blocked) return;
    if (await props.onSend(text)) setDraft('');
  };

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
        <div className="asv-composer">
          <textarea
            ref={inputRef}
            className="asv-composer-input"
            placeholder={placeholder}
            value={draft}
            rows={1}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
            aria-label={props.direct ? '消息' : '追加指令'}
          />
          <div className="asv-composer-bar">
            <span className="asv-composer-hint">Enter 发送 · Shift+Enter 换行</span>
            {props.running && (
              <button type="button" className="asv-round-btn" disabled={props.interrupting} onClick={props.onInterrupt} aria-label="中断本轮" title="中断本轮">
                <Square size={12} fill="currentColor" />
              </button>
            )}
            <button type="button" className="asv-round-btn is-primary" disabled={!draft.trim() || props.sending || blocked} onClick={() => void send()} aria-label="发送" title="发送">
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
        {props.model && <Chip icon={<Cpu size={12} />}>{props.model}</Chip>}
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
        ) : props.readOnly && <Chip icon={<Lock size={12} />}>只读</Chip>}
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
