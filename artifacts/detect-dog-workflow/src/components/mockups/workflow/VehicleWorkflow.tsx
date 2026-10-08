import { ArrowRight, Clock3, GitBranch, Info } from 'lucide-react';
import { formatTime, getPromiseRisk, type Job, type ShopState } from './_shared/model';
import { JobActions } from './JobActions';
import { RiskBadge, StatusBadge } from './DispatchBoard';

export function VehicleWorkflow({state,vehicleId,manager,techId,onStart,onPause,onComplete,onEdit}:{
  state:ShopState;vehicleId:string;manager:boolean;techId:string;onStart:(j:Job)=>void;onPause:(j:Job)=>void;onComplete:(j:Job)=>void;onEdit:(j:Job)=>void;
}) {
  const vehicle=state.vehicles.find(v=>v.id===vehicleId)!;
  const jobs=state.jobs.filter(j=>j.vehicleId===vehicleId);
  const risk=getPromiseRisk(state,vehicleId);
  const firstStart=Math.min(...jobs.map(j=>j.start));
  return <div data-testid="vehicle-workflow">
    <div style={{display:'flex',justifyContent:'space-between',gap:10,alignItems:'center'}}><div><p className="muted">#{vehicle.ro} · {vehicle.owner}</p><p>{vehicle.concern}</p></div><RiskBadge state={state} vehicleId={vehicleId}/></div>
    <div className="workflow-summary">
      <div><small>Arrival</small><strong className="mono">{formatTime(vehicle.arrival)}</strong></div><div><small>First planned work</small><strong className="mono">{formatTime(firstStart)}</strong></div>
      <div><small>Promised ready</small><strong className="mono">{formatTime(vehicle.promise)}</strong></div><div><small>Illustrative finish</small><strong className="mono" style={risk.level==='risk'?{color:'var(--danger)'}:undefined}>{formatTime(risk.finish)}</strong></div>
    </div>
    <div style={{fontSize:12,color:'var(--quiet)'}}><Clock3 className="icon" style={{width:13,height:13,display:'inline',verticalAlign:'middle'}}/> {risk.slack<0?`${Math.abs(risk.slack)} min past promise`:`${risk.slack} min promise buffer`} · {jobs.filter(j=>j.session==='completed').length} of {jobs.length} jobs complete</div>
    {vehicleId==='v1' && <><div className="flow-strip"><GitBranch className="icon"/><span>Diagnosis</span><ArrowRight className="icon"/><span>Repair</span><ArrowRight className="icon"/><span>Alignment</span><ArrowRight className="icon"/><span>Road test</span></div><p className="muted" style={{fontSize:12}}>Oil service can run in parallel. Each handoff releases only when its prerequisites are complete.</p></>}
    {jobs.map(job=><article className={`job-detail ${job.session}`} key={job.id} data-testid={`workflow-job-${job.id}`}>
      <div className="job-detail-top"><div><div className="eyebrow muted">{job.resource?'Shared alignment rack':job.dependencies.length?'Dependent work':'Independent work'}</div><h3>{job.title}</h3><p>{state.technicians.find(t=>t.id===job.techId)?.name} · planned <span className="mono">{formatTime(job.start)}</span>{job.resource?' · requires rack':''}</p></div><StatusBadge state={state} job={job}/></div>
      <div className="job-times"><span><b>{job.book}m</b> book labor</span><span><b>{job.predicted}m</b> predicted tech time</span><span><b>{job.activeMinutes}m</b> active session</span><span><b>{job.waitingMinutes}m</b> paused waiting</span></div>
      {state.demoMode==='burnett' && <p>{job.sourcePackage?<>YTD package reference: <strong>{job.sourcePackage}</strong>. Title shortened for the board.</>:'Illustrative workflow step; not derived from a CSV package.'} Assignment and all times are simulated, not this technician’s historical performance.</p>}
      {manager || job.techId===techId ? <JobActions state={state} job={job} manager={manager} onStart={onStart} onPause={onPause} onComplete={onComplete} onEdit={onEdit}/>:
        <p className="muted">Controls belong to {state.technicians.find(t=>t.id===job.techId)?.name}. Use the Demo technician switch to try their work.</p>}
    </article>)}
    <div className="prediction-note"><Info className="icon" style={{width:13,height:13,verticalAlign:'middle',display:'inline'}}/> <strong>Four different clocks.</strong> {state.demoMode==='burnett'?'All displayed times are demonstration values, not estimates learned from Burnett’s CSV. The export’s Technician Hours nearly always match billed hours, so they are not treated as actual clocked time.':'Book labor is a fictional billed allowance. Predicted tech time is an illustrative median from 7–12 invented comparable jobs per task, not trained AI.'} Active session minutes accrue only while working; waiting minutes accrue only while paused. Unstarted queue time is not included in either timer.<br/><br/>Finish projection uses remaining predicted time (minimum 5 min), dependencies, planned-order technician queues, breaks and one rack. Paused work adds a fictional 30-minute remaining hold. Red = past promise; Watch = 30 min or less buffer. Projection is not a guarantee.</div>
  </div>;
}
