import { memo, useRef, useState, type KeyboardEvent } from 'react';
import { resolveTitleEdit } from '../../lib/session-title';

/**
 * The session title in the page header. With `onRename` a double click (or Enter / F2 while it is
 * focused) turns it into a text field: Enter saves, Escape or leaving the field unchanged cancels.
 */
export const SessionTitle = memo(function SessionTitle({ title, onRename }: {
  title: string;
  onRename?: (title: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  if (!onRename) return <span className="asv-title">{title}</span>;

  const begin = () => {
    setDraft(title);
    setError(null);
  };
  const cancel = () => {
    setDraft(null);
    setError(null);
  };
  const commit = async (fromBlur: boolean) => {
    if (draft === null || savingRef.current) return;
    const edit = resolveTitleEdit(draft, title);
    if (edit.action === 'noop') return cancel();
    if (edit.action === 'reject') {
      // Leaving the field with an unusable title gives up the edit instead of trapping focus.
      if (fromBlur) cancel();
      else setError(edit.error);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    const ok = await onRename(edit.title).catch(() => false);
    savingRef.current = false;
    setSaving(false);
    if (ok) cancel();
  };

  if (draft === null) {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === 'F2') {
        event.preventDefault();
        begin();
      }
    };
    return (
      <span
        className="asv-title is-editable"
        role="button"
        tabIndex={0}
        title="双击改名"
        onDoubleClick={begin}
        onKeyDown={onKeyDown}
      >
        {title}
      </span>
    );
  }

  return (
    <span className="asv-title-edit">
      <input
        className="asv-title-input"
        value={draft}
        autoFocus
        disabled={saving}
        aria-label="会话标题"
        aria-invalid={error ? true : undefined}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => {
          setDraft(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void commit(false);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            cancel();
          }
        }}
        onBlur={() => void commit(true)}
      />
      {error && <span className="asv-title-error" role="alert">{error}</span>}
    </span>
  );
});
