import { useState } from 'react';
import { MessageCircleQuestion } from 'lucide-react';
import { DRIVER_LABELS } from '../lib/session-capabilities';
import type { AgentDriverId, WorkerNativeQuestionPayload } from '../types';

export interface WorkerNativeQuestionCardProps {
  entry: WorkerNativeQuestionPayload;
  workerLabel?: string | null;
  variant: 'board' | 'crew';
  onFocusWorker?: () => void;
  onNotify?: (message: string) => void;
}

const providerLabel = (provider: string): string => DRIVER_LABELS[provider as AgentDriverId] ?? provider;

/**
 * Answers the structured questions a headless Worker's own agent asked (Codex `requestUserInput`,
 * Claude `AskUserQuestion`, ACP elicitation, Grok `ask_user_question`), on the Board and in the
 * Crew drawer. Every question needs an answer before it can be sent; skipping declines them all.
 */
export function WorkerNativeQuestionCard({
  entry,
  workerLabel,
  variant,
  onFocusWorker,
  onNotify,
}: WorkerNativeQuestionCardProps) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const answerFor = (id: string): string[] => {
    const selected = picked[id] ?? [];
    const custom = other[id]?.trim();
    return custom && !selected.includes(custom) ? [...selected, custom] : selected;
  };
  const complete = entry.questions.every((question) => answerFor(question.id).length > 0);
  const buildAnswers = (): Record<string, string[]> =>
    Object.fromEntries(entry.questions.map((question) => [question.id, answerFor(question.id)]));

  const submit = async (answers: Record<string, string[]> | null) => {
    const api = window.vibeMeet.orchestration?.workerAnswerQuestion;
    if (!api) {
      onNotify?.('当前环境不支持回复 Worker 提问');
      return;
    }
    setBusy(true);
    try {
      const res = await api({ id: entry.requestId, dispatchId: entry.dispatchId, answers });
      onNotify?.(!res.ok ? res.error : answers ? '已回复 Worker 提问' : '已跳过 Worker 提问');
    } finally {
      setBusy(false);
    }
  };

  const toggle = (questionId: string, multiSelect: boolean | undefined, label: string) => {
    if (multiSelect) {
      setPicked((prev) => {
        const current = prev[questionId] ?? [];
        const next = current.includes(label) ? current.filter((item) => item !== label) : [...current, label];
        return { ...prev, [questionId]: next };
      });
      return;
    }
    setPicked((prev) => ({ ...prev, [questionId]: [label] }));
    setOther((prev) => (prev[questionId] ? { ...prev, [questionId]: '' } : prev));
  };

  const board = variant === 'board';
  const title = `${providerLabel(entry.provider)} Worker 提问`;
  return (
    <div className={board ? 'obp-inline-card is-warn' : 'aha-crew-alert-card'} role="group" aria-label={title}>
      <div className={board ? 'obp-inline-card-head' : 'aha-crew-alert-head'}>
        {board ? (
          <span>
            <MessageCircleQuestion size={12} /> {title}
            {workerLabel ? <> · <strong>{workerLabel}</strong></> : null}
          </span>
        ) : (
          <strong>{workerLabel ? `${workerLabel} 提问` : title}</strong>
        )}
        {onFocusWorker && (
          <button type="button" className={board ? 'wrp-btn obp-btn-sm' : 'aha-crew-link-btn'} onClick={onFocusWorker}>
            查看会话
          </button>
        )}
      </div>
      {entry.questions.map((question) => {
        const selected = picked[question.id] ?? [];
        return (
          <div key={question.id} className={board ? 'obp-native-qa' : 'aha-crew-native-qa'}>
            <p className={board ? 'obp-inline-card-text' : 'aha-crew-question-text'}>
              {question.header ? <><strong>{question.header}</strong>{' '}</> : null}
              {question.prompt}
              {question.multiSelect ? '（可多选）' : null}
            </p>
            {question.options.length > 0 && (
              <div className={board ? 'obp-option-chips' : 'aha-crew-chips'}>
                {question.options.map((option, index) => {
                  const isSelected = selected.includes(option.label);
                  return (
                    <button
                      key={`${index}:${option.label}`}
                      type="button"
                      title={option.description || undefined}
                      className={board ? `wrp-btn obp-btn-sm${isSelected ? ' is-primary' : ''}` : isSelected ? 'is-selected' : undefined}
                      aria-pressed={isSelected}
                      disabled={busy}
                      onClick={() => toggle(question.id, question.multiSelect, option.label)}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            )}
            {question.allowOther && (
              <div className={board ? 'obp-reply-row' : 'aha-crew-inline-actions'}>
                <input
                  type="text"
                  placeholder={question.options.length > 0 ? '或输入其他答复…' : '输入答复…'}
                  aria-label={`${question.header || question.prompt} 的答复`}
                  disabled={busy}
                  value={other[question.id] ?? ''}
                  onChange={(event) => {
                    const value = event.target.value;
                    setOther((prev) => ({ ...prev, [question.id]: value }));
                    if (!question.multiSelect && value.trim()) {
                      setPicked((prev) => (prev[question.id]?.length ? { ...prev, [question.id]: [] } : prev));
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing && complete && !busy) {
                      event.preventDefault();
                      void submit(buildAnswers());
                    }
                  }}
                />
              </div>
            )}
          </div>
        );
      })}
      <div className={board ? 'obp-inline-card-btns' : 'aha-crew-inline-actions'}>
        <button type="button" className={board ? 'wrp-btn obp-btn-sm' : undefined} disabled={busy} onClick={() => void submit(null)}>
          跳过
        </button>
        <button
          type="button"
          className={board ? 'wrp-btn is-primary obp-btn-sm' : 'is-accent'}
          disabled={busy || !complete}
          onClick={() => void submit(buildAnswers())}
        >
          答复
        </button>
      </div>
    </div>
  );
}
