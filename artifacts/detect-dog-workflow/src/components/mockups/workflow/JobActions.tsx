import { Check, LockKeyhole, Pause, Play, SlidersHorizontal } from 'lucide-react';
import { getPrerequisites, getReadiness, type Job, type ShopState } from './_shared/model';

export function JobActions({state,job,manager,onStart,onPause,onComplete,onEdit}:{
  state:ShopState;job:Job;manager:boolean;onStart:(j:Job)=>void;onPause:(j:Job)=>void;onComplete:(j:Job)=>void;onEdit:(j:Job)=>void;
}) {
  const blocked=getReadiness(state,job)==='blocked';
  return <>
    {blocked && <div className="dependency-note" data-testid={`blocked-${job.id}`}><LockKeyhole className="icon" style={{width:13,height:13}}/>Waiting for {getPrerequisites(state,job).map(j=>j.title).join(' + ')} to complete.</div>}
    {job.session==='paused' && <div className="dependency-note">Paused: {job.reason} · waiting {job.waitingMinutes} min</div>}
    {job.session!=='completed' && <div className="actions">
      {job.session==='active'?<><button className="btn orange" onClick={()=>onPause(job)} data-testid={`pause-${job.id}`}><Pause className="icon"/>Pause</button><button className="btn primary" onClick={()=>onComplete(job)} data-testid={`complete-${job.id}`}><Check className="icon"/>Complete</button></>:
        <button className="btn primary" onClick={()=>onStart(job)} disabled={blocked} data-testid={`start-${job.id}`}><Play className="icon"/>{job.session==='paused'?'Resume':'Start job'}</button>}
      {manager && <button className="btn" onClick={()=>onEdit(job)} disabled={job.session==='active'} title={job.session==='active'?'Pause work before changing its assignment':'Change assigned technician and planned start'} data-testid={`edit-${job.id}`}><SlidersHorizontal className="icon"/>Assignment & time</button>}
    </div>}
  </>;
}
