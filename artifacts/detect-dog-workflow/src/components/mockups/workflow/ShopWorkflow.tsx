import { useState, type FormEvent } from 'react';
import { ArrowRight, Dog, FileCheck2, GitBranch, LayoutDashboard, Paintbrush, RotateCcw, Users, Wrench } from 'lucide-react';
import { Dialog } from './_shared/Dialog';
import { useShop } from './_shared/useShop';
import { PAUSE_REASONS, formatTime, parseTime, type DemoMode, type Job, type ShopAction } from './_shared/model';
import { DispatchBoard } from './DispatchBoard';
import { MyWork } from './MyWork';
import { VehicleWorkflow } from './VehicleWorkflow';
import { BrandSettings } from './BrandSettings';
import { Experience } from './Experience';
import { useBranding } from './_shared/useBranding';
import { LOCATION_IDS, LOCATION_LABELS, brandingTheme, resolveBranding, type LocationId } from './_shared/branding';
import './workflow.css';

type Modal = {type:'pause'|'edit'|'switch'|'error';jobId:string;message?:string;currentId?:string} | {type:'reset'} | {type:'dataset';mode:DemoMode};

export function ShopWorkflow() {
  const {state,act,notice,changeDemo}=useShop();
  const {branding,applyBranding,storageError}=useBranding();
  const brand=resolveBranding(branding);
  const burnett=state.demoMode==='burnett';
  const [view,setView]=useState<'dispatch'|'vehicles'|'work'|'experience'|'branding'>('dispatch');
  const [role,setRole]=useState<'dispatcher'|'technician'>('dispatcher');
  const [techId,setTechId]=useState('t1');
  const [selected,setSelected]=useState<string|null>(null);
  const [modal,setModal]=useState<Modal|null>(null);
  const [error,setError]=useState('');
  const [reason,setReason]=useState<string>(PAUSE_REASONS[0]);
  const [assignment,setAssignment]=useState('t1');
  const [start,setStart]=useState('10:30');
  const manager=role==='dispatcher';
  const modalJob=modal && 'jobId' in modal?state.jobs.find(j=>j.id===modal.jobId):undefined;
  const selectVehicle=(id:string)=>setSelected(id);
  const openPause=(job:Job)=>{setReason(PAUSE_REASONS[0]);setError('');setModal({type:'pause',jobId:job.id});};
  const openEdit=(job:Job)=>{setAssignment(job.techId);setStart(formatTime(job.start));setError('');setModal({type:'edit',jobId:job.id});};
  const startJob=(job:Job)=>{
    const result=act({type:'start',jobId:job.id});
    if (!result.ok) {setError('');setModal({type:result.conflictingJobId?'switch':'error',jobId:job.id,message:result.message,currentId:result.conflictingJobId});}
  };
  const completeJob=(job:Job)=>{
    const result=act({type:'complete',jobId:job.id});
    if (!result.ok) setModal({type:'error',jobId:job.id,message:result.message});
  };
  const submit=(event:FormEvent)=>{
    event.preventDefault();
    if (!modal) return;
    if (modal.type==='dataset') {
      changeDemo(modal.mode);
      setModal(null);setError('');setSelected(null);setView('dispatch');setRole('dispatcher');setTechId('t1');
      return;
    }
    let action:ShopAction;
    if (modal.type==='reset') action={type:'reset'};
    else if (modal.type==='pause') action={type:'pause',jobId:modal.jobId,reason};
    else if (modal.type==='edit') action={type:'assign',jobId:modal.jobId,techId:assignment,start:parseTime(start)};
    else if (modal.type==='switch') action={type:'start',jobId:modal.jobId,pauseCurrent:true};
    else return;
    const result=act(action);
    if (result.ok) {setModal(null);setError('');if(action.type==='reset'){setSelected(null);setView('dispatch');setRole('dispatcher');setTechId('t1');}}
    else setError(result.message);
  };
  const actionProps={onStart:startJob,onPause:openPause,onComplete:completeJob,onEdit:openEdit};
  const vehicle=state.vehicles.find(v=>v.id===selected);
  const changeView=(next:typeof view)=>{setSelected(null);setView(next);};
  const modalTitles={pause:'Pause this job',edit:'Assignment & planned start',switch:'Switch active work?',error:'This job cannot start',reset:'Reset the demo?',dataset:'Switch demo dataset?'};
  return <div className="dd" style={brandingTheme(branding)} data-density={branding.density}><div className="shell">
    <aside className="sidebar"><div><div className="brand">{brand.logo?<img className="brand-logo" src={brand.logo} alt={`${brand.enterpriseName} logo`}/>:<div className="brand-mark"><Dog/></div>}<span>{brand.inherited?brand.enterpriseName:brand.locationName}</span></div><div className="powered"><Dog size={13}/>Powered by Detect Dog</div><div className="location-label">{brand.locationName}</div></div>
      <nav aria-label="Main navigation"><button className={view==='dispatch'?'active':''} aria-current={view==='dispatch'?'page':undefined} onClick={()=>changeView('dispatch')} data-testid="nav-dispatch"><LayoutDashboard className="icon"/>Dispatch<span className="nav-number">01</span></button>
        <button className={view==='vehicles'?'active':''} aria-current={view==='vehicles'?'page':undefined} onClick={()=>changeView('vehicles')} data-testid="nav-vehicles"><GitBranch className="icon"/>Vehicles<span className="nav-number">10</span></button>
        <button className={view==='work'?'active':''} aria-current={view==='work'?'page':undefined} onClick={()=>changeView('work')} data-testid="nav-my-work"><Wrench className="icon"/>My Work<span className="nav-number">03</span></button>
        <button className={view==='experience'?'active':''} aria-current={view==='experience'?'page':undefined} onClick={()=>changeView('experience')} data-testid="nav-experience"><FileCheck2 className="icon"/>Experience</button>
        <button className={view==='branding'?'active':''} aria-current={view==='branding'?'page':undefined} onClick={()=>changeView('branding')} data-testid="nav-branding"><Paintbrush className="icon"/>Brand settings</button></nav>
      <div className="shift-note"><div className="eyebrow">{burnett?'YTD presentation':'Fictional shop'}</div><strong>{burnett?'Burnett historical evidence':'Juniper Auto Works'}</strong>{burnett?'Location not onboarded. Schedule is illustrative.':'Independent by design. Connected by the next job.'}<div style={{marginTop:20,display:'flex',alignItems:'center',gap:6}}><span className="dot"/>Simulated shift · 08:00–17:00</div></div>
      <div className="sidebar-bottom"><div className="eyebrow">Presentation prototype</div><span>Branding saved in this browser.</span><span>Workflow resets on refresh.</span><span>Proposed theme, not official branding.</span></div>
    </aside>
    <main className="main"><header className="topbar"><div className="topbar-left"><span className="demo-label">INTERACTIVE DEMO</span><span className="muted" style={{fontSize:11}}>{burnett?'YTD staff & service evidence · simulated schedule':'All names & data are fictional'}</span></div>
      <div className="role-controls"><label>Demo dataset <select aria-label="Demo dataset" data-testid="demo-dataset" value={state.demoMode} onChange={e=>{const mode=e.target.value as DemoMode;if(mode!==state.demoMode){setError('');setModal({type:'dataset',mode});}}}><option value="burnett">Burnett YTD presentation</option><option value="fictional">Original fictional demo</option></select></label>
        <label>Presentation location <select aria-label="Presentation location" value={branding.activeLocation} onChange={e=>applyBranding({...branding,activeLocation:e.target.value as LocationId})}>{LOCATION_IDS.map(id=><option key={id} value={id}>{LOCATION_LABELS[id]}</option>)}</select></label>
        <label>Demo role <select aria-label="Demo role" data-testid="demo-role" value={role} onChange={e=>{const next=e.target.value as typeof role;setRole(next);setSelected(null);setView(next==='technician'?'work':'dispatch');}}><option value="dispatcher">Dispatcher</option><option value="technician">Technician</option></select></label>
        <label>Demo technician <select aria-label="Demo technician" data-testid="demo-technician" value={techId} onChange={e=>{setTechId(e.target.value);setSelected(null);}}>{state.technicians.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
        <button className="btn quiet" onClick={()=>{setError('');setModal({type:'reset'});}} data-testid="reset-demo" aria-label="Reset demo"><RotateCcw className="icon"/><span>Reset</span></button></div>
    </header>
    <div className="source-banner" data-testid="source-disclaimer">{burnett?<><strong>Burnett · location not onboarded · Jan 2–Oct 7, 2026</strong>Technicians and service history are real; customers, vehicles, repair orders, assignments, schedule, durations, and timers are illustrative.</>:<><strong>Original fictional demo</strong>All workflow names and data are fictional. Burnett historical evidence is shown separately on the Experience page.</>}<div>Presentation location only: changing location shows the same simulated schedule. Branding is a proposed theme, not official Burnett branding.</div></div>
    {storageError && view!=='branding' && <div className="form-error" role="alert">{storageError} <button className="btn" onClick={()=>changeView('branding')}>Open brand settings</button></div>}
    {view==='experience' && <Experience fictional={!burnett}/>}
    {view==='branding' && <BrandSettings branding={branding} applyBranding={applyBranding} storageError={storageError}/>}
    {view==='dispatch' && <DispatchBoard state={state} selected={selected} onSelect={selectVehicle} onAdvance={()=>act({type:'advance'})}/>}
    {view==='work' && <MyWork state={state} techId={techId} onSelect={selectVehicle} onAdvance={()=>act({type:'advance'})} {...actionProps}/>}
    {view==='vehicles' && <div className="page" data-testid="vehicles-view"><div className="page-heading"><div><div className="eyebrow muted">Arrival → work → promise</div><h1>Every vehicle has a journey.</h1><p className="muted">Open a workflow to see who owns the next step.</p></div><Users className="icon"/></div>
      <div className="vehicle-list">{state.vehicles.map(v=><button className="vehicle-row" key={v.id} onClick={()=>selectVehicle(v.id)} data-testid={`directory-${v.id}`}>
        <span><strong>{v.name}</strong><small>#{v.ro} · {v.owner}</small></span><span className="row-progress"><strong>{v.concern}</strong><small>Arrived {formatTime(v.arrival)}</small></span><span className="promise-col"><strong>{formatTime(v.promise)}</strong><small>Promised</small></span><span className="tag">{state.jobs.filter(j=>j.vehicleId===v.id).length} jobs</span><ArrowRight className="icon"/></button>)}</div>
      <div className="prediction-note">Select a vehicle for dependencies, assignments, timers and promise risk. In Demo technician mode, job controls are limited to the selected technician.</div>
    </div>}
    </main>
  </div>
  {vehicle && <Dialog title={vehicle.name} subtitle={`Vehicle workflow · #${vehicle.ro}`} onClose={()=>setSelected(null)} active={!modal}>
    <VehicleWorkflow state={state} vehicleId={vehicle.id} manager={manager} techId={techId} {...actionProps}/>
  </Dialog>}
  {modal && <Dialog compact title={modalTitles[modal.type]} subtitle={modalJob?`${modalJob.title} · #${state.vehicles.find(v=>v.id===modalJob.vehicleId)?.ro}`:'All demo data'} onClose={()=>{setModal(null);setError('');}}>
    <form onSubmit={submit} data-testid={`${modal.type}-form`}>
      {modal.type==='pause' && <><p className="muted">Stop the active timer and record what’s holding up this job. Dependencies remain blocked until completion.</p><div className="field"><label htmlFor="pause-reason">Pause reason</label><select id="pause-reason" value={reason} onChange={e=>setReason(e.target.value)} data-testid="pause-reason">{PAUSE_REASONS.map(r=><option key={r}>{r}</option>)}</select></div></>}
      {modal.type==='edit' && <><p className="muted">Update ownership and the planned half-hour slot. This does not start work or bypass prerequisites.</p><div className="field"><label htmlFor="assignment">Assigned technician</label><select id="assignment" data-testid="assignment-tech" value={assignment} onChange={e=>setAssignment(e.target.value)}>{state.technicians.map(t=><option key={t.id} value={t.id}>{t.name} · {t.specialty}</option>)}</select></div><div className="field"><label htmlFor="planned-start">Planned start · half-hour intervals</label><input id="planned-start" data-testid="assignment-start" type="time" step={1800} min="08:00" max="16:30" required value={start} onChange={e=>setStart(e.target.value)}/></div><p className="muted" style={{fontSize:11}}>Planned overlaps are allowed and visible on the board. The finish projection queues jobs by plan and respects breaks and resources. Any technician may be assigned in this demo; skill certification is not modeled.</p></>}
      {modal.type==='switch' && <><p>{modal.message}</p><p className="muted">Pause that job with reason “Switched to another job” and start {modalJob?.title}? Active time is preserved.</p></>}
      {modal.type==='error' && <p className="form-error">{modal.message}</p>}
      {modal.type==='reset' && <><p>Restore the current {burnett?'Burnett presentation':'fictional'} simulated vehicles, assignments and timers to 10:15?</p><p className="muted">Workflow changes in this tab will be discarded. The selected dataset and saved branding are preserved. No workflow data is saved or sent anywhere.</p></>}
      {modal.type==='dataset' && <><p>Switch to {modal.mode==='burnett'?'Burnett YTD presentation':'the original fictional demo'}?</p><p className="muted">This resets simulated scheduling, assignments, vehicles, and timers. You will return to Dispatch with technician t1 selected. Branding is separate and will not change.</p></>}
      {error && <p role="alert" className="form-error" data-testid="action-error">{error}</p>}
      <div className="actions"><button type="button" className="btn" onClick={()=>{setModal(null);setError('');}}>{modal.type==='error'?'Got it':'Cancel'}</button>{modal.type!=='error' && <button type="submit" className="btn primary" data-testid="confirm-action">{modal.type==='pause'?'Pause job':modal.type==='edit'?'Save changes':modal.type==='switch'?'Pause current & start':modal.type==='dataset'?'Switch & reset schedule':'Reset workflow'}</button>}</div>
    </form>
  </Dialog>}
  <div aria-live="polite" aria-atomic="true">{notice && <div className="toast" data-testid="toast">{notice}</div>}</div>
  </div>;
}

export default ShopWorkflow;
