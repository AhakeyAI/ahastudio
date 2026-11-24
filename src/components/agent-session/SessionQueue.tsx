import { memo } from 'react';
import { CornerDownLeft, ListOrdered, Paperclip, PencilLine, Play, X } from 'lucide-react';
import type { AgentQueuedMessage } from '../../types';

const QueuedRow = memo(function QueuedRow({ message, index, busy, onEdit, onRemove }: {
  message: AgentQueuedMessage; index: number; busy: boolean;
  onEdit: (id: string) => void; onRemove: (id: string) => void;
}) {
  const files = message.attachments.filter((item) => item.type !== 'skill').length;
  const firstLine = message.text.split('\n').find((line) => line.trim()) ?? '';
  return (
    <li className="asv-queue-row">
      <span className="asv-queue-index" aria-hidden="true">{index + 1}</span>
      <span className="asv-queue-text" title={message.text}>{firstLine || '（仅附件）'}</span>
      {files > 0 && (
        <span className="asv-queue-files" title={`${files} 个附件`}><Paperclip size={11} aria-hidden="true" />{files}</span>
      )}
      <button type="button" className="asv-act" disabled={busy} aria-label="取回编辑" title="取回到输入框编辑" onClick={() => onEdit(message.id)}>
        <PencilLine size={13} />
      </button>
      <button type="button" className="asv-act" disabled={busy} aria-label="移出队列" title="移出队列" onClick={() => onRemove(message.id)}>
        <X size={13} />
      </button>
    </li>
  );
});

/** Messages waiting for the running turn, shown above the input in the order they will be sent. */
export function SessionQueue({ queued, paused, busy, onEdit, onRemove, onResume }: {
  queued: readonly AgentQueuedMessage[];
  paused: boolean;
  busy: boolean;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onResume: () => void;
}) {
  if (!queued.length) return null;
  return (
    <section className={`asv-queue${paused ? ' is-paused' : ''}`} aria-label="排队的消息">
      <header className="asv-queue-head">
        <ListOrdered size={13} aria-hidden="true" />
        {paused ? (
          <span>已暂停 · 上一轮没有正常结束，{queued.length} 条消息等你确认后再发</span>
        ) : (
          <span>排队中 {queued.length} 条 · 本轮结束后依次发送</span>
        )}
        <span className="asv-spacer" />
        {paused ? (
          <button type="button" className="asv-text-btn" disabled={busy} onClick={onResume}>
            <Play size={11} aria-hidden="true" /> 继续发送
          </button>
        ) : (
          <span className="asv-queue-hint"><CornerDownLeft size={11} aria-hidden="true" /> 继续输入也会排在后面</span>
        )}
      </header>
      <ol className="asv-queue-list">
        {queued.map((message, index) => (
          <QueuedRow key={message.id} message={message} index={index} busy={busy} onEdit={onEdit} onRemove={onRemove} />
        ))}
      </ol>
    </section>
  );
}
