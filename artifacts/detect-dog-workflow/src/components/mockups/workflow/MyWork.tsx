import { ArrowRight, CheckCheck, Clock3 } from 'lucide-react';
import { DAY_END, formatTime, getActiveJob, getWorkload, type Job, type ShopState } from './_shared/model';
import { RiskBadge, StatusBadge } from './DispatchBoard';
import { JobActions } from './JobActions';

export function MyWork({state,techId,onSelect,onStart,onPause,onComplete,onAdvance}:{
  state:ShopState;techId:string;onSelect:(id:string)=>void;onStart:(j:Job)=>void;onPause:(j:Job)=>void;onComplete:(j:Job)=>void;onAdvance:()=>void;
}) {
  const tech=state.technicians.find(t=>t.id===techId)!;
  const active=getActiveJob(state,techId);
  const jobs=state.jobs.filter(j=>j.techId===techId).sort((a,b)=>Number(b.session==='active')-Number(a.session==='active') || Number(a.session==='completed')-Number(b.session==='completed') || a.start-b.start);
  return <div className="page my-work" data-testid="my-work-view"><div className="page-heading"><div><div className="eyebrow muted">Individual jobs · {tech.specialty}</div><h1>Your next move.</h1><p className="muted">One active job at a time. Every handoff stays connected.</p></div><div className="clock-control"><span className="clock mono">{formatTime(state.now)}</span><button className="btn" onClick={onAdvance} disabled={state.now+15>DAY_END}><Clock3 className="icon"/>+15 min</button></div></div>
    <div className="work-banner"><div><div className="eyebrow">Demo technician</div><h2>{tech.name}</h2><p>{active?`Working on ${active.title}`:'No active session · choose a ready job'} · {getWorkload(state,techId)} min remaining predicted work</p></div><div className="avatar">{tech.name.split(' ').map(s=>s[0]).join('')}</div></div>
    {jobs.map(job=>{
      const vehicle=state.vehicles.find(v=>v.id===job.vehicleId)!;
      return <article className="work-card" key={job.id} data-testid={`my-job-${job.id}`}><div style={{display:'flex',justifyContent:'space-between',gap:10}}><StatusBadge state={state} job={job}/><RiskBadge state={state} vehicleId={vehicle.id}/></div>
        <h3>{job.title}</h3><p>{vehicle.name} <span className="muted">· #{vehicle.ro}</span></p><p className="muted" style={{fontSize:12}}>Planned {formatTime(job.start)} · promised {formatTime(vehicle.promise)}</p>
        <div className="job-times"><span><b>{job.book}m</b> book</span><span><b>{job.predicted}m</b> predicted</span><span><b>{job.activeMinutes}m</b> active</span><span><b>{job.waitingMinutes}m</b> waiting</span></div>
        <JobActions state={state} job={job} manager={false} onStart={onStart} onPause={onPause} onComplete={onComplete} onEdit={()=>{}}/>
        <button className="btn quiet" style={{marginTop:12,paddingLeft:0}} onClick={()=>onSelect(vehicle.id)}>See vehicle workflow<ArrowRight className="icon"/></button>
      </article>;
    })}
    {!jobs.length && <div className="empty"><CheckCheck className="icon"/><h3>Your queue is clear.</h3><p className="muted">The dispatcher can assign your next job. Try a different demo technician above.</p></div>}
    <div className="prediction-note">{state.demoMode==='burnett'?'Employee names come from YTD history; assignments and all times are simulated. No efficiency or speed is inferred from Burnett’s Technician Hours.':'Predicted time is an illustrative median of 7–12 invented comparable jobs, not trained AI.'} Timers only move when you use +15 min. Paused waiting excludes unstarted queue time.</div>
  </div>;
}
