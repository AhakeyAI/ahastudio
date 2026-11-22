import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, Cpu, Folder, GitBranch, Lock, MessageCircleQuestion, ShieldAlert, Square } from 'lucide-react';
import { formatTokenCount } from '../../lib/worker-timeline-model';
import type { OrchestrationQuestionRecord, WorkerTimelineItem } from '../../types';
import { useAgentSession } from './session-context';

type ApprovalItem = Extract<WorkerTimelineItem, { kind: 'approval' }>;

const COMPOSER_MAX_HEIGHT = 200;

function ApprovalBanner({ item }: { item: ApprovalItem }) {
  const { onNotify } = useAgentSession();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const api = window.vibeMeet?.orchestration;
  const decide = async (allow: boolean) => {
    const call = allow ? api?.approve : api?.deny;
    if (!call) return;
    setBusy(true);
    try {
      const res = await call({ id: item.approvalId, ...(allow ? {} : { reason: reason.trim() || 'Denied from Agent session' }) });
      if (!res.ok) onNotify?.(res.error);
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

  const send = async () => {
    const text = draft.trim();
    if (!text || props.sending) return;
    if (await props.onSend(text)) setDraft('');
  };

  return (
    <div className="asv-dock-inner">
      {(props.approvals.length > 0 || props.questions.length > 0) && (
        <div className="asv-banner-lane">
          {props.approvals.map((item) => <ApprovalBanner key={item.id} item={item} />)}
          {props.questions.map((question) => <QuestionBanner key={question.messageId} question={question} />)}
        </div>
      )}
      {props.alive ? (
        <div className="asv-composer">
          <textarea
            ref={inputRef}
            className="asv-composer-input"
            placeholder={props.running ? '补充指令，本轮结束后送达' : '给 Worker 发送追加指令'}
            value={draft}
            rows={1}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
            aria-label="追加指令"
          />
          <div className="asv-composer-bar">
            <span className="asv-composer-hint">Enter 发送 · Shift+Enter 换行</span>
            {props.running && (
              <button type="button" className="asv-round-btn" disabled={props.interrupting} onClick={props.onInterrupt} aria-label="中断本轮" title="中断本轮">
                <Square size={12} fill="currentColor" />
              </button>
            )}
            <button type="button" className="asv-round-btn is-primary" disabled={!draft.trim() || props.sending} onClick={() => void send()} aria-label="发送" title="发送">
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
        {props.readOnly && <Chip icon={<Lock size={12} />}>只读</Chip>}
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
