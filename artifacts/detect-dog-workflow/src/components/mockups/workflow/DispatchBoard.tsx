import { ArrowRight, Check, ChevronRight, Clock3, Coffee, Info, LockKeyhole, Search, Sparkles, Wrench } from 'lucide-react';
import { useState } from 'react';
import { DAY_END, DAY_START, formatTime, getJobStatus, getPromiseRisk, getReadiness, getWorkload, type Job, type ShopState } from './_shared/model';

export function RiskBadge({ state, vehicleId }: {state:ShopState;vehicleId:string}) {
  const risk=getPromiseRisk(state,vehicleId);
  return <span className={`tag ${risk.level}`} title={`Projected finish ${formatTime(risk.finish)}. ${Math.abs(risk.slack)} minutes ${risk.slack<0?'late':'buffer'}.`}>
    {risk.level==='on-track'?<Check className="icon" style={{width:11,height:11}}/>:<Clock3 className="icon" style={{width:11,height:11}}/>}
    {risk.level==='on-track'?'On track':risk.level==='watch'?'Watch':'At risk'}
  </span>;
}
export function StatusBadge({state,job}:{state:ShopState;job:Job}) {
  const status=getJobStatus(state,job);
  return <span className={`tag ${status}`}>{status==='blocked'?<LockKeyhole className="icon" style={{width:11,height:11}}/>:<span className={`dot ${status}`}/>}
    {status==='active'?'In progress':status==='completed'?'Complete':status.charAt(0).toUpperCase()+status.slice(1)}
  </span>;
}
export function DispatchBoard({state,selected,onSelect,onAdvance}:{
  state:ShopState;selected:string|null;onSelect:(id:string)=>void;onAdvance:()=>void;
}) {
  const [search,setSearch]=useState('');
  const riskCount=state.vehicles.filter(v=>getPromiseRisk(state,v.id).level==='risk').length;
  const ready=state.jobs.filter(j=>getReadiness(state,j)==='ready' && j.session==='idle').length;
  const active=state.jobs.filter(j=>j.session==='active').length;
  const flagshipNext=state.jobs.find(j=>j.vehicleId==='v1' && j.session!=='completed');
  const position=(minute:number)=>(minute-DAY_START)/(DAY_END-DAY_START)*100;
  const filtered=state.vehicles.filter(v=>`${v.name} ${v.owner} ${v.ro}`.toLowerCase().includes(search.toLowerCase()));
  const jobBlock=(job:Job) => {
    const vehicle=state.vehicles.find(v=>v.id===job.vehicleId)!;
    const status=getJobStatus(state,job);
    return <button key={job.id} data-testid={`timeline-${job.id}${job.resource?'-rack-job':''}`} className={`job-block ${status} ${selected===job.vehicleId?'selected':selected?'dimmed':''}`}
      style={{left:`${position(job.start)}%`,width:`${Math.min(Math.max(job.predicted,35),DAY_END-job.start)/(DAY_END-DAY_START)*100}%`,top:15}}
      aria-label={`${vehicle.name}, ${job.title}, ${status}, planned ${formatTime(job.start)}`}
      title={`RO ${vehicle.ro} · ${vehicle.name}\n${job.title} · ${status}\nPlanned ${formatTime(job.start)} · predicted ${job.predicted} min`}
      onClick={()=>onSelect(job.vehicleId)}>
      <strong>#{vehicle.ro} · {vehicle.name.split(' ')[1]}</strong><small>{job.title}</small>
      <span className="block-state">{status==='blocked'?<LockKeyhole style={{width:9,height:9}}/>:status==='completed'?<Check style={{width:9,height:9}}/>:<span className={`dot ${status}`}/>}
        {status==='active'?'Working':status==='completed'?'Done':status.charAt(0).toUpperCase()+status.slice(1)}
      </span>
    </button>;
  };
  const nowLine=<div className="now" style={{left:`${position(state.now)}%`}}/>;
  return <div className="page" data-testid="dispatch-view">
    <div className="page-heading"><div><div className="eyebrow muted">{state.demoMode==='burnett'?'Burnett presentation · simulated workday':'Tuesday, 14 May · Fictional demo day'}</div><h1>A clear view of the shop.</h1><p className="muted">Six technicians. One connected plan. Keep the next job moving.</p></div>
      <div className="clock-control"><div><div className="eyebrow muted">Shop clock</div><div className="clock mono" data-testid="shop-clock">{formatTime(state.now)}</div></div>
        <button className="btn" onClick={onAdvance} disabled={state.now+15>DAY_END} data-testid="advance-clock"><Clock3 className="icon"/>+15 min</button>
      </div>
    </div>
    <div className="summary">
      <div className="summary-cell"><div className="eyebrow muted">Vehicles in shop</div><div className="summary-value">{state.vehicles.length}<small>{state.jobs.length} individual jobs</small></div><div className="summary-label">From arrival to road test</div></div>
      <div className="summary-cell"><div className="eyebrow muted">Hands on now</div><div className="summary-value">{active}<small>/ 6 technicians</small></div><div className="summary-label">{ready} ready jobs in the queue</div></div>
      <div className="summary-cell alert"><div className="eyebrow muted">Promise attention</div><div className="summary-value">{riskCount}<small>vehicles at risk</small></div><div className="summary-label">Based on illustrative finish times</div></div>
      <div className="summary-cell"><div className="eyebrow muted">Next to watch · #{state.vehicles[0].ro}</div><div style={{margin:'10px 0 7px',fontWeight:700}}>Outback → {flagshipNext?.title ?? 'Ready for pickup'}</div><div className="summary-label">{flagshipNext?`${getJobStatus(state,flagshipNext).charAt(0).toUpperCase()+getJobStatus(state,flagshipNext).slice(1)} · ${state.technicians.find(t=>t.id===flagshipNext.techId)?.name}`:'All jobs complete'}</div></div>
    </div>
    <div className="section-heading"><h2>Today’s dispatch</h2><div className="legend"><span><i className="dot"/>Working</span><span><i className="dot ready"/>Ready</span><span><LockKeyhole style={{width:11,height:11}}/>Blocked</span><span><i className="dot paused"/>Paused</span><span><Coffee style={{width:12,height:12}}/>Break</span></div></div>
    <div className="board" data-testid="dispatch-timeline">
      <div className="board-scroll" tabIndex={0} role="region" aria-label="Technician schedule, scroll horizontally to see all hours">
        <div className="board-inner">
          <div className="time-header"><span>TECH / OPEN WORK</span><div className="hours">{Array.from({length:9},(_,i)=><span key={i}>{formatTime(DAY_START+i*60)}</span>)}<div className="now-label" style={{left:`${position(state.now)}%`}}>NOW {formatTime(state.now)}</div></div></div>
          {state.technicians.map(tech=><div className="lane" key={tech.id} data-testid={`lane-${tech.id}`}>
            <div className="person"><div className="avatar">{tech.name.split(' ').map(s=>s[0]).join('')}</div><div><strong>{tech.name}</strong><small>{Math.round(getWorkload(state,tech.id)/6)/10}h open · {tech.specialty.split(' ')[0]}</small><small>{Math.round(getWorkload(state,tech.id)/(DAY_END-DAY_START-(tech.breakEnd-tech.breakStart))*100)}% of 8.5h capacity</small><div className="load-meter"><i style={{width:`${Math.min(getWorkload(state,tech.id)/510*100,100)}%`}}/></div></div></div>
            <div className="track"><div className="break" style={{left:`${position(tech.breakStart)}%`,width:`${(tech.breakEnd-tech.breakStart)/540*100}%`}} title={`Break ${formatTime(tech.breakStart)}–${formatTime(tech.breakEnd)}`}>BREAK</div>
              {state.jobs.filter(j=>j.techId===tech.id).map(jobBlock)}{nowLine}
            </div>
          </div>)}
          <div className="lane rack" data-testid="lane-rack"><div className="person"><div className="avatar"><Wrench className="icon"/></div><div><strong>Alignment rack</strong><small>Shared resource · 1 bay</small><small>{state.jobs.some(j=>j.resource==='rack' && j.session==='active')?'Occupied now':'Available now'}</small></div></div>
            <div className="track">{state.jobs.filter(j=>j.resource==='rack').map(job=> <div key={job.id} data-testid={`rack-${job.id}`}>{jobBlock(job)}</div>)}{nowLine}</div>
          </div>
        </div>
      </div>
      <div className="board-footer"><span>Half-hour grid · blocks show planned start + illustrative predicted duration</span><span>Rack jobs appear in both assigned-tech and resource lanes.</span></div>
    </div>
    <div className="lower-grid"><section><div className="section-heading"><h2>Vehicle journeys <span className="muted" style={{fontSize:12,fontWeight:400}}> / {filtered.length}</span></h2><label className="search"><Search className="icon"/><input aria-label="Search vehicles" placeholder="Find vehicle or RO…" value={search} onChange={e=>setSearch(e.target.value)}/></label></div>
      <div className="vehicle-list">{filtered.map(vehicle=>{
        const jobs=state.jobs.filter(j=>j.vehicleId===vehicle.id);
        const completed=jobs.filter(j=>j.session==='completed').length;
        const working=jobs.find(j=>j.session==='active');
        return <button className="vehicle-row" key={vehicle.id} onClick={()=>onSelect(vehicle.id)} data-testid={`vehicle-${vehicle.id}`} aria-label={`Open ${vehicle.name} workflow`}>
          <span><strong>{vehicle.name}</strong><small>#{vehicle.ro} · {vehicle.owner} · arrived {formatTime(vehicle.arrival)}</small></span>
          <span className="row-progress"><strong>{completed}/{jobs.length} jobs complete</strong><small>{working?`${working.title} in progress`:completed===jobs.length?'Ready for pickup':'Next work in queue'}</small></span>
          <span className="promise-col"><strong className="mono">{formatTime(vehicle.promise)}</strong><small>Promised</small></span>
          <RiskBadge state={state} vehicleId={vehicle.id}/><ChevronRight className="icon"/>
        </button>;
      })}{!filtered.length && <div className="empty"><Search className="icon"/><h3>No vehicles match “{search}”</h3><p className="muted">Try a make, owner name or repair-order number.</p><button className="btn" onClick={()=>setSearch('')}>Clear search</button></div>}</div>
    </section><aside className="guide"><Sparkles className="icon guide-icon"/><div className="eyebrow muted">Take it for a spin</div><h3>One vehicle.<br/>A whole-shop handoff.</h3><p>Follow the Outback from diagnosis to road test.</p><ol><li>Pause diagnosis for parts.</li><li>Reassign its ready oil service.</li><li>Resume and complete diagnosis.</li><li>Watch repair become ready.</li></ol><button className="btn primary" data-testid="open-scenario" onClick={()=>onSelect('v1')}>Open the Outback<ArrowRight className="icon"/></button></aside></div>
    <div className="footnote"><Info className="icon" style={{width:12,height:12}}/>{state.demoMode==='burnett'?'Employee names and selected service descriptions come from YTD history. Assignments, vehicles, customers and every time shown are simulated—not live Burnett work.':'All people, work orders and estimates are fictional.'} Workflow changes stay in this tab only.</div>
  </div>;
}
