import { useEffect, useRef, type ReactNode } from 'react';

/** A panel that opens above its trigger and closes on an outside click or Escape. */
export function ComposerPopover({
  open, onClose, trigger, children, align = 'start', className = '',
}: {
  open: boolean;
  onClose: () => void;
  trigger: ReactNode;
  children: ReactNode;
  align?: 'start' | 'end';
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose]);
  return (
    <div className="asv-pop-anchor" ref={ref}>
      {trigger}
      {open && <div className={`asv-pop is-${align} ${className}`} role="dialog">{children}</div>}
    </div>
  );
}
