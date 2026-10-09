import { useEffect, useRef, useState } from 'react';
import { ClipboardCheck, Dog, FileText, RotateCcw, Route, ShieldCheck } from 'lucide-react';
import { applyAction, composeInspectionLines, createDemoState, isCompleted, isReviewed, type DemoAction } from './model';
import { Button, Modal } from './components/dvi/Common';
import { Technician } from './components/dvi/Technician';
import { Advisor } from './components/dvi/Advisor';
import { Customer } from './components/dvi/Customer';

type View = 'technician' | 'advisor' | 'customer';
function App() {
  const [state, setState] = useState(createDemoState);
  const [view, setView] = useState<View>('technician');
  const [dialog, setDialog] = useState<'reset' | 'walkthrough' | null>(null);
  const [toast, setToast] = useState('');
  const stateRef = useRef(state);
  stateRef.current = state;
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timeout.current) clearTimeout(timeout.current); composeInspectionLines(stateRef.current).flatMap(l => l.media).forEach(m => URL.revokeObjectURL(m.url)); }, []);
  const notify = (message: string) => { setToast(message); if (timeout.current) clearTimeout(timeout.current); timeout.current = setTimeout(() => setToast(''), 5500); };
  const dispatch = (action: DemoAction) => {
    const result = applyAction(stateRef.current, action);
    if (result.ok) { stateRef.current = result.state; setState(result.state); }
    if (!result.ok || ['complete', 'review', 'handoff', 'reset', 'sample-green'].includes(action.type)) notify(result.message);
    return result.ok;
  };
  const navigate = (next: View) => { setView(next); window.scrollTo({ top: 0, behavior: 'instant' }); };
  return <div className="app">
    <aside className="sidebar"><div className="brand"><span className="brand-mark"><Dog /></span><div>Detect Dog<small>SHOP FLOOR / DVI</small></div></div>
      <nav aria-label="Demo views">{([{ id: 'technician', name: 'Technician', icon: ClipboardCheck }, { id: 'advisor', name: 'Advisor ticket', icon: FileText }, { id: 'customer', name: 'Customer report', icon: ShieldCheck }] as const).map((item, i) => <button className={`nav ${view === item.id ? 'active' : ''}`} key={item.id} aria-current={view === item.id ? 'page' : undefined} data-testid={`nav-${item.id}`} onClick={() => navigate(item.id)}><span className="step">0{i + 1}</span><item.icon />{item.name}</button>)}</nav>
      <div className="sidebar-note"><span className="eyebrow">One connected record</span><strong>Inspect → review → present</strong><p>The same findings and evidence follow the vehicle. Nothing is sent.</p></div><div className="sidebar-bottom">Enterprise Tire DVI Demo<span style={{ display: 'block' }}>Fictional people, vehicle and prices.<br />Browser memory only.</span></div>
    </aside><main className="main"><header className="topbar"><div className="topbar-left"><span className="demo">DEMO</span><strong>Enterprise Tire · Westfield</strong><span className="muted">Fictional presentation location</span></div><div className="actions"><Button onClick={() => setDialog('walkthrough')} data-testid="walkthrough"><Route /> Five-minute walkthrough</Button><Button onClick={() => setDialog('reset')} data-testid="reset-demo"><RotateCcw /> Reset demo</Button></div></header>
      <div className="page"><section className="context" aria-label="Fictional visit context"><div><small>FICTIONAL VEHICLE / CUSTOMER</small><strong>2019 Meridian S4</strong><small>Rowan Hale · staggered wheel fitment</small></div><div><small>DEMO REPAIR ORDER</small><strong className="mono">#2086 <small>· 62,418 mi</small></strong><small>Tire & battery inspection</small></div><div><small>CURRENT RECORD / REV {state.revision}</small><strong>{isReviewed(state) ? 'Advisor reviewed' : isCompleted(state) ? 'Ready for review' : 'Inspection in progress'}</strong><small>{state.handoffRevision === state.revision ? 'Simulated handoff · nothing sent' : 'No external connection'}</small></div></section>
      {view === 'technician' && <Technician state={state} dispatch={dispatch} onAdvisor={() => navigate('advisor')} />}
      {view === 'advisor' && <Advisor state={state} dispatch={dispatch} onCustomer={() => navigate('customer')} onTechnician={() => navigate('technician')} />}
      {view === 'customer' && <Customer state={state} onAdvisor={() => navigate('advisor')} />}
      <footer className="footer"><strong>Demo, not a live inspection system.</strong> Manual entries and local media previews are working interactions. Sample AI findings are fictional presets, not analysis. Protractor-style handoff is simulated; no ticket, upload, message or public report is created. Refresh clears all session data.</footer></div>
    </main>
    {dialog === 'reset' && <Modal title="Reset this demo?" onClose={() => setDialog(null)}><p>Clear all measurements, optional checks, evidence previews, recommendations and review status. Restore the fictional visit. This cannot be undone.</p><div className="actions" style={{ marginTop: 20 }}><Button onClick={() => setDialog(null)}>Keep this record</Button><Button primary data-testid="confirm-reset" onClick={() => { composeInspectionLines(state).flatMap(l => l.media).forEach(m => URL.revokeObjectURL(m.url)); dispatch({ type: 'reset' }); setView('technician'); setDialog(null); }}>Reset demo record</Button></div></Modal>}
    {dialog === 'walkthrough' && <Modal title="Five-minute presenter walkthrough" onClose={() => setDialog(null)}><p>All people, measurements and prices are fictional. Start with a clean demo record.</p><ol><li><strong>0:00 — Inspect.</strong> Select each wheel. Point out actual staggered sizes, I / C / O units and independent before / after pressure.</li><li><strong>1:00 — Document green.</strong> Open Sample AI findings. Review the fictional preset, then explicitly confirm. No media is analyzed. Optional: add a local photo.</li><li><strong>2:00 — Show the gate.</strong> Clear one mandatory result; Complete inspection explains the missing entry. Restore it and complete. Battery result is manual, never inferred.</li><li><strong>3:00 — Build the ticket.</strong> All four tires, battery and safety checks appear in the $0 documentation package. Add an optional tire recommendation and edit quantity or price. After edits, return to technician to reconfirm completion, then confirm advisor review.</li><li><strong>4:00 — Present.</strong> Open the customer report. Findings, evidence and proposed pricing match. Return to advisor and simulate handoff: no real ticket is created. Reset to repeat.</li></ol><div className="notice success">Working: manual inputs, validation, local files, optional checks, pricing, review gates and reset.<br />Simulated: sample AI preset and Protractor handoff. No APIs, storage, login or live AI.</div><Button primary onClick={() => setDialog(null)}>Start walkthrough</Button></Modal>}
    {toast && <div className="toast" role="status" data-testid="toast">{toast}</div>}
  </div>;
}
export default App;
