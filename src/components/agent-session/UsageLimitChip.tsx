import { memo, useState } from 'react';
import { Gauge } from 'lucide-react';
import type { UsageSummary } from '../../lib/usage-limits';

/** Usage of the Codex account in the composer footer; hovering or focusing shows each window. */
export const UsageLimitChip = memo(function UsageLimitChip({ summary }: { summary: UsageSummary }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className={`asv-chip asv-usage is-${summary.level}`}
      tabIndex={0}
      aria-label={`Codex 额度：${summary.text}`}
      data-open={open || undefined}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <Gauge size={12} />
      <span>{summary.text}</span>
      {open && (
        <span className="asv-usage-pop" role="tooltip">
          <span className="asv-usage-title">Codex 额度{summary.planType ? ` · ${summary.planType}` : ''}</span>
          {summary.windows.map((window, index) => (
            <span key={index} className="asv-usage-row">
              <span className="asv-usage-line">
                <span className="asv-usage-label">{window.label}</span>
                <span className="asv-usage-used">{window.used}</span>
              </span>
              <span className={`asv-usage-bar is-${window.level}`}><i style={{ width: `${window.percent}%` }} /></span>
              {window.reset && <span className="asv-usage-reset">{window.reset}</span>}
            </span>
          ))}
        </span>
      )}
    </span>
  );
});
