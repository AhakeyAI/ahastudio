import { useCallback, useState } from 'react';
import { Check, ChevronUp } from 'lucide-react';
import { effortLabel } from '../../lib/composer-tokens';
import type { CodexModelOption } from '../../types';
import { ComposerPopover } from './ComposerPopover';

/** Model list with the chosen model's reasoning levels below it; changes apply from the next message. */
export function ComposerModelPicker({
  models, model, fallbackLabel, effort, disabled, open: controlledOpen, onOpenChange, onModelChange, onEffortChange,
}: {
  models: readonly CodexModelOption[];
  model: CodexModelOption | null;
  /** Shown when the session uses a model the catalog does not list. */
  fallbackLabel: string | null;
  effort: string | null;
  disabled: boolean;
  /** Controlled open state so `/model` can open the picker directly. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onModelChange: (model: CodexModelOption) => void;
  onEffortChange: (effort: string) => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = useCallback((next: boolean | ((value: boolean) => boolean)) => {
    const resolved = typeof next === 'function' ? next(open) : next;
    if (onOpenChange) onOpenChange(resolved);
    else setUncontrolledOpen(resolved);
  }, [open, onOpenChange]);
  const close = useCallback(() => setOpen(false), [setOpen]);
  const label = model?.displayName ?? fallbackLabel ?? '默认模型';
  return (
    <ComposerPopover
      open={open}
      onClose={close}
      className="asv-model-pop"
      trigger={(
        <button
          type="button"
          className={`asv-tool-btn${open ? ' is-open' : ''}`}
          disabled={disabled || models.length === 0}
          aria-haspopup="dialog"
          aria-expanded={open}
          title={disabled ? '本轮结束后可以切换模型' : '模型与推理强度：下一条消息起生效'}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="asv-tool-label">{label}</span>
          {effort && <span className="asv-tool-sub">{effortLabel(effort)}</span>}
          <ChevronUp size={12} aria-hidden="true" />
        </button>
      )}
    >
      <div className="asv-pop-section">
        <div className="asv-pop-heading">模型</div>
        <div className="asv-pop-list" role="listbox" aria-label="模型">
          {models.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="option"
              aria-selected={entry.id === model?.id}
              className={`asv-pop-row${entry.id === model?.id ? ' is-selected' : ''}`}
              onClick={() => onModelChange(entry)}
            >
              <span className="asv-pop-row-main">
                <span className="asv-pop-row-title">
                  {entry.displayName}
                  {entry.isDefault && <span className="asv-pop-badge">默认</span>}
                </span>
                {entry.description && <span className="asv-pop-row-desc">{entry.description}</span>}
              </span>
              {entry.id === model?.id && <Check size={14} aria-hidden="true" />}
            </button>
          ))}
        </div>
      </div>
      {model && model.efforts.length > 0 && (
        <div className="asv-pop-section">
          <div className="asv-pop-heading">推理强度</div>
          <div className="asv-effort-row" role="radiogroup" aria-label="推理强度">
            {model.efforts.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={option.value === effort}
                className={`asv-effort${option.value === effort ? ' is-selected' : ''}`}
                title={option.description || undefined}
                onClick={() => onEffortChange(option.value)}
              >
                {effortLabel(option.value)}
              </button>
            ))}
          </div>
          {model.efforts.find((option) => option.value === effort)?.description && (
            <div className="asv-pop-note">{model.efforts.find((option) => option.value === effort)!.description}</div>
          )}
        </div>
      )}
    </ComposerPopover>
  );
}
