import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function Dialog({ title, subtitle, onClose, children, compact = false, active = true }: {
  title: string; subtitle?: string; onClose: () => void; children: ReactNode; compact?: boolean; active?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    returnFocus.current = document.activeElement as HTMLElement | null;
    return () => { if (returnFocus.current?.isConnected) returnFocus.current.focus(); };
  }, []);
  useEffect(() => {
    if (!active) return;
    const element = ref.current;
    const focusable = () => Array.from(element?.querySelectorAll<HTMLElement>('button:not([disabled]),select:not([disabled]),input:not([disabled]),a[href],[tabindex="0"]') ?? []);
    (lastFocus.current?.isConnected ? lastFocus.current : focusable()[0] ?? element)?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); }
      if (event.key === 'Tab') {
        const nodes=focusable();
        const first=nodes[0]; const last=nodes[nodes.length-1];
        if (!first) { event.preventDefault(); element?.focus(); return; }
        if (event.shiftKey && (document.activeElement===first || document.activeElement===element)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement===last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown',handleKey);
    return () => { document.removeEventListener('keydown',handleKey); };
  }, [active]);
  return <div className="overlay" style={compact ? {zIndex:60} : undefined} onMouseDown={event => { if (event.target===event.currentTarget && active) onClose(); }}>
    <div ref={ref} className={`dialog ${compact?'compact':''}`} role="dialog" aria-modal={active || undefined} aria-label={title} tabIndex={-1} inert={!active} onFocusCapture={event => { lastFocus.current=event.target as HTMLElement; }}>
      <div className="dialog-header"><div>{subtitle && <div className="eyebrow muted">{subtitle}</div>}<h2>{title}</h2></div>
        <button className="btn quiet close" onClick={onClose} aria-label={`Close ${title}`}><X className="icon"/></button>
      </div>{children}
    </div>
  </div>;
}
