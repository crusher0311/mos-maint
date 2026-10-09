import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Camera, X } from 'lucide-react';
import { RATING_LABELS, type Rating, type BatteryResult, type Media, type InspectionLine } from '../../model';

export function Button({ children, onClick, primary = false, disabled = false, ...rest }: { children: ReactNode; onClick: () => void; primary?: boolean; disabled?: boolean; 'data-testid'?: string; 'aria-label'?: string }) {
  return <button type="button" className={`btn${primary ? ' primary' : ''}`} onClick={onClick} disabled={disabled} {...rest}>{children}</button>;
}
export function Field({ label, value, onChange, type = 'text', placeholder, min, max, step }: { label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string; min?: number; max?: number; step?: string }) {
  return <label className="field">{label}<input aria-label={label} type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} min={min} max={max} step={step ?? 'any'} /></label>;
}
export function Notes({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return <label className="field">{label}<textarea aria-label={label} value={value} onChange={e => onChange(e.target.value)} placeholder="What did you observe?" /></label>;
}
export function Status({ value }: { value: Rating | BatteryResult }) {
  const color = value === 'red' || value === 'fail' ? 'red' : value === 'yellow' ? 'yellow' : value === 'green' || value === 'pass' ? '' : 'neutral';
  return <span className={`badge ${color}`}>{RATING_LABELS[value]}</span>;
}
export function Ratings({ label, value, onChange, optional = false }: { label: string; value: Rating; onChange: (v: Rating) => void; optional?: boolean }) {
  const values: Rating[] = optional ? ['green', 'yellow', 'red', 'not-applicable', 'not-inspected'] : ['green', 'yellow', 'red', 'not-inspected'];
  return <div><div className="section-label">Manually confirmed rating</div><div className="rating" role="group" aria-label={`${label} rating`}>{values.map(r => <button type="button" key={r} aria-label={`${label} ${RATING_LABELS[r]}`} aria-pressed={value === r} onClick={() => onChange(r)}>{RATING_LABELS[r]}</button>)}</div></div>;
}
export function Evidence({ items, onRemove }: { items: Media[]; onRemove?: (id: string) => void }) {
  return <div className="evidence-grid">{items.map(m => <div className="evidence" key={m.id}><figure>{m.kind === 'image' ? <img src={m.url} alt={`Local evidence: ${m.name}`} /> : <video src={m.url} controls preload="metadata" aria-label={`Local video: ${m.name}`} />}<figcaption>{m.name} · local only</figcaption></figure>{onRemove && <Button aria-label={`Remove ${m.name}`} onClick={() => onRemove(m.id)}><X /> Remove</Button>}</div>)}</div>;
}
export function MediaInput({ label, items, onChange, imageOnly = false }: { label: string; items: Media[]; onChange: (items: Media[]) => void; imageOnly?: boolean }) {
  const [error, setError] = useState('');
  return <div className="media"><div className="row hint"><Camera /> {imageOnly ? 'Local test-printout image' : 'Local photo / video evidence'} · no upload</div><label className="field">{label}<input aria-label={label} type="file" accept={imageOnly ? 'image/png,image/jpeg,image/webp' : 'image/png,image/jpeg,image/webp,video/mp4,video/webm'} multiple onChange={e => {
    const files = Array.from(e.target.files ?? []);
    const allowed = imageOnly ? ['image/png', 'image/jpeg', 'image/webp'] : ['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'video/webm'];
    if (files.some(f => !allowed.includes(f.type) || f.size > 30 * 1024 * 1024)) { setError('Choose PNG, JPEG, WebP, MP4 or WebM files under 30 MB (images only for battery printouts).'); e.target.value = ''; return; }
    setError('');
    onChange([...items, ...files.map((f, i) => ({ id: `${Date.now()}-${i}-${f.name}`, name: f.name, url: URL.createObjectURL(f), kind: f.type.startsWith('image/') ? 'image' as const : 'video' as const }))]);
    e.target.value = '';
  }} /></label>{error && <p role="alert" className="notice error">{error} Select another file to retry.</p>}<Evidence items={items} onRemove={id => { const m = items.find(item => item.id === id); if (m) URL.revokeObjectURL(m.url); onChange(items.filter(item => item.id !== id)); }} /></div>;
}
export function Panel({ title, description, badge, children }: { title: string; description?: string; badge?: ReactNode; children: ReactNode }) {
  return <section className="panel"><div className="panel-header"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{badge}</div><div className="panel-body">{children}</div></section>;
}
export function Always() { return <span className="badge always">Always document</span>; }
export function InspectionLines({ lines }: { lines: InspectionLine[] }) {
  return <div>{lines.map(line => <article className="line" key={line.id} data-testid={`line-${line.id}`}><div className="line-top"><div className="row"><h3>{line.title}</h3>{line.mandatory && <Always />}</div><Status value={line.rating} /></div>{!line.inspected && <p className="hint"><strong>{line.rating === 'not-applicable' ? 'Not applicable — not inspected.' : 'Not inspected / tested.'}</strong> No completed inspection is claimed for this item.</p>}<p className="mono">{line.details}</p>{line.notes && <p className="notes">{line.notes}</p>}<Evidence items={line.media} /></article>)}</div>;
}
export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; ref.current?.showModal(); return () => { previous?.focus(); }; }, []);
  return <dialog ref={ref} aria-label={title} onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}><div className="line-top"><h2>{title}</h2><Button aria-label={`Close ${title}`} onClick={onClose}><X /></Button></div>{children}</dialog>;
}
export const money = (amount: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
