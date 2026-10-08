import { burnettPresentation } from './burnett';
export type DemoMode = 'fictional' | 'burnett';
export type Session = 'idle' | 'active' | 'paused' | 'completed';
export type Readiness = 'ready' | 'blocked' | 'completed';
export interface Technician { id: string; name: string; specialty: string; breakStart: number; breakEnd: number }
export interface Vehicle { id: string; ro: string; name: string; owner: string; concern: string; arrival: number; promise: number }
export interface Job {
  id: string; vehicleId: string; title: string; techId: string; start: number;
  book: number; predicted: number; dependencies: string[]; resource?: 'rack';
  session: Session; activeMinutes: number; waitingMinutes: number; reason?: string;
  sourcePackage?: string;
}
export interface ShopState { demoMode: DemoMode; now: number; technicians: Technician[]; vehicles: Vehicle[]; jobs: Job[] }
export type ShopAction =
  | { type: 'advance'; minutes?: number }
  | { type: 'pause'; jobId: string; reason: string }
  | { type: 'start'; jobId: string; pauseCurrent?: boolean }
  | { type: 'complete'; jobId: string }
  | { type: 'assign'; jobId: string; techId: string; start: number }
  | { type: 'reset' };
export type Result = { ok: true; state: ShopState; message: string } | { ok: false; state: ShopState; message: string; conflictingJobId?: string };
export const DAY_START = 480;
export const DAY_END = 1020;
export const PAUSE_REASONS = ['Waiting for parts', 'Waiting for approval', 'Diagnostic research', 'Helping another technician', 'Taking a break'] as const;
export function formatTime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${String(hours % 24).padStart(2, '0')}:${String(Math.floor(minutes % 60)).padStart(2, '0')}`;
}
export function parseTime(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
}
export function createDemoState(mode: DemoMode = 'fictional'): ShopState {
  const technicians: Technician[] = [
    {id:'t1',name:'Mara Voss',specialty:'Diagnostics',breakStart:720,breakEnd:750},
    {id:'t2',name:'Eli Mercer',specialty:'Drivetrain',breakStart:750,breakEnd:780},
    {id:'t3',name:'Nina Calder',specialty:'Brakes & chassis',breakStart:720,breakEnd:750},
    {id:'t4',name:'Owen Reed',specialty:'Alignment',breakStart:780,breakEnd:810},
    {id:'t5',name:'Tess Rowan',specialty:'Service & electrical',breakStart:750,breakEnd:780},
    {id:'t6',name:'Jules Hart',specialty:'Inspection & testing',breakStart:720,breakEnd:750},
  ];
  const vehicles: Vehicle[] = [
    {id:'v1',ro:'1042',name:'2018 Subaru Outback',owner:'Avery Finch',concern:'Front-end vibration · pulls right',arrival:480,promise:840},
    {id:'v2',ro:'1043',name:'2021 Honda Civic',owner:'Rory Bell',concern:'Brake noise · routine service',arrival:495,promise:780},
    {id:'v3',ro:'1044',name:'2016 Ford Transit',owner:'Marlow Studio',concern:'Intermittent no-start',arrival:510,promise:870},
    {id:'v4',ro:'1045',name:'2020 Toyota RAV4',owner:'Casey Vale',concern:'Maintenance · tire rotation',arrival:525,promise:735},
    {id:'v5',ro:'1046',name:'2019 Mazda CX-5',owner:'Emery Lane',concern:'Uneven tire wear',arrival:540,promise:900},
    {id:'v6',ro:'1047',name:'2017 VW Golf',owner:'Robin Dale',concern:'Coolant leak · pressure test',arrival:550,promise:945},
    {id:'v7',ro:'1048',name:'2022 Kia Sorento',owner:'Drew Ash',concern:'Battery warning',arrival:570,promise:900},
    {id:'v8',ro:'1049',name:'2015 Volvo V60',owner:'Sage Arden',concern:'Suspension noise',arrival:580,promise:975},
    {id:'v9',ro:'1050',name:'2020 Nissan Leaf',owner:'Quinn Moss',concern:'Annual inspection · tires',arrival:590,promise:990},
    {id:'v10',ro:'1051',name:'2018 Ford Escape',owner:'Reese Linden',concern:'Rough idle',arrival:600,promise:1005},
  ];
  const jobs: Job[] = [];
  const add = (id:string,vehicleId:string,title:string,techId:string,start:number,book:number,predicted:number,dependencies:string[]=[],session:Session='idle',activeMinutes=0,resource?:'rack') =>
    jobs.push({id,vehicleId,title,techId,start,book,predicted,dependencies,session,activeMinutes,waitingMinutes:0,resource});
  add('j1','v1','Diagnosis','t1',570,60,65,[],'active',22);
  add('j2','v1','Control arm repair','t2',660,90,85,['j1']);
  add('j3','v1','Wheel alignment','t4',780,60,50,['j2'],'idle',0,'rack');
  add('j4','v1','Road test','t6',840,30,25,['j3']);
  add('j5','v1','Oil & filter service','t5',630,30,35);
  add('j6','v2','Brake inspection','t3',510,60,50,[],'completed',44);
  add('j7','v2','Front brake pads','t3',600,60,70,['j6'],'active',12);
  add('j8','v2','Safety check','t6',690,30,25,['j7']);
  add('j9','v3','Electrical diagnosis','t1',660,90,80);
  add('j10','v3','Starter replacement','t2',810,60,65,['j9']);
  add('j11','v4','Scheduled service','t5',540,60,65,[],'active',37);
  add('j12','v4','Tire rotation','t6',630,30,30,['j11']);
  add('j13','v5','Steering inspection','t3',690,30,35);
  add('j14','v5','Wheel alignment','t4',660,60,55,['j13'],'idle',0,'rack');
  add('j15','v6','Cooling system test','t2',570,60,45,[],'completed',39);
  add('j16','v6','Water pump repair','t2',900,90,95,['j15']);
  add('j17','v7','Charging system test','t5',690,45,40);
  add('j18','v7','Battery replacement','t5',810,30,25,['j17']);
  add('j19','v8','Suspension inspection','t3',810,60,55);
  add('j20','v8','Strut replacement','t3',900,90,85,['j19']);
  add('j21','v8','Wheel alignment','t4',930,60,50,['j20'],'idle',0,'rack');
  add('j22','v9','Annual inspection','t6',780,45,40);
  add('j23','v9','Tire balance','t4',870,45,40);
  add('j24','v10','Engine diagnosis','t1',810,60,70);
  add('j25','v10','Ignition service','t5',900,60,55,['j24']);
  const seed: ShopState = {demoMode:'fictional',now:615,technicians,vehicles,jobs};
  return mode==='burnett' ? burnettPresentation(seed) : seed;
}
export function getReadiness(state: ShopState, job: Job): Readiness {
  if (job.session === 'completed') return 'completed';
  return job.dependencies.every(id => state.jobs.some(j => j.id === id && j.session === 'completed')) ? 'ready' : 'blocked';
}
export function getPrerequisites(state: ShopState, job: Job): Job[] {
  return state.jobs.filter(j => job.dependencies.includes(j.id) && j.session !== 'completed');
}
export function getActiveJob(state: ShopState, techId: string): Job | undefined {
  return state.jobs.find(j => j.techId === techId && j.session === 'active');
}
export function getJobStatus(state: ShopState, job: Job): string {
  if (job.session !== 'idle') return job.session;
  return getReadiness(state, job);
}
export function getWorkload(state: ShopState, techId: string): number {
  return state.jobs.filter(j => j.techId === techId && j.session !== 'completed').reduce((sum,j) => sum + Math.max(0,j.predicted-j.activeMinutes),0);
}
/** Illustrative deterministic projection, not a trained model or a dispatch optimizer.
 *  Jobs follow dependencies then planned-order queues; tech breaks and rack occupancy
 *  are respected. A paused job carries a fictional 30-minute remaining hold.
 */
export function projectSchedule(state: ShopState): Record<string,{start:number;end:number}> {
  const result: Record<string,{start:number;end:number}> = {};
  const techFree: Record<string,number> = {};
  let rackFree = state.now;
  const pending = state.jobs.filter(j => j.session !== 'completed').sort((a,b) =>
    Number(b.session==='active')-Number(a.session==='active') || a.start-b.start || a.id.localeCompare(b.id));
  state.jobs.filter(j => j.session === 'completed').forEach(j => { result[j.id] = {start:j.start,end:Math.min(state.now,j.start+j.activeMinutes)}; });
  let guard = 0;
  while (pending.length && guard++ < state.jobs.length*2) {
    const index = pending.findIndex(j => j.dependencies.every(id => !!result[id]));
    if (index < 0) break;
    const job = pending.splice(index,1)[0];
    const tech = state.technicians.find(t => t.id === job.techId)!;
    let start = Math.max(state.now,job.session==='active'?state.now:job.start,techFree[job.techId] ?? state.now,...job.dependencies.map(id=>result[id].end));
    if (job.session==='paused') start += 30;
    if (job.resource) start = Math.max(start,rackFree);
    const duration = Math.max(5,job.predicted-job.activeMinutes);
    if (start < tech.breakEnd && start+duration > tech.breakStart) start=tech.breakEnd;
    result[job.id] = {start,end:start+duration};
    techFree[job.techId]=start+duration;
    if (job.resource) rackFree=start+duration;
  }
  return result;
}
export function getPromiseRisk(state: ShopState, vehicleId: string): {level:'on-track'|'watch'|'risk'; finish:number; slack:number} {
  const vehicle = state.vehicles.find(v => v.id===vehicleId)!;
  const projection = projectSchedule(state);
  const finish = Math.max(vehicle.arrival,...state.jobs.filter(j=>j.vehicleId===vehicleId).map(j=>projection[j.id]?.end ?? DAY_END+60));
  const slack=vehicle.promise-finish;
  return {level:slack<0?'risk':slack<=30?'watch':'on-track',finish,slack};
}
export function applyAction(state: ShopState, action: ShopAction): Result {
  const fail = (message:string,conflictingJobId?:string):Result => ({ok:false,state,message,conflictingJobId});
  if (action.type==='reset') return {ok:true,state:createDemoState(state.demoMode),message:'Demo reset. All original assignments restored.'};
  if (action.type==='advance') {
    const minutes=action.minutes ?? 15;
    if (!Number.isFinite(minutes) || minutes<=0 || state.now+minutes>DAY_END) return fail('The demo clock runs from 08:00 to 17:00.');
    return {ok:true,state:{...state,now:state.now+minutes,jobs:state.jobs.map(j=>({...j,activeMinutes:j.activeMinutes+(j.session==='active'?minutes:0),waitingMinutes:j.waitingMinutes+(j.session==='paused'?minutes:0)}))},message:`Clock advanced to ${formatTime(state.now+minutes)}. Active and paused timers updated.`};
  }
  const job=state.jobs.find(j=>j.id===action.jobId);
  if (!job) return fail('Job not found. Reset the demo to restore it.');
  let updates: Partial<Job> = {};
  let pauseId: string | undefined;
  if (action.type==='assign') {
    if (job.session==='active' || job.session==='completed') return fail('Pause active work before editing. Completed jobs cannot be edited.');
    if (!state.technicians.some(t=>t.id===action.techId)) return fail('Choose an available technician.');
    if (!Number.isFinite(action.start) || action.start<Math.max(DAY_START,state.vehicles.find(v=>v.id===job.vehicleId)!.arrival) || action.start+job.predicted>DAY_END || action.start%30!==0) return fail('Choose a half-hour start after arrival, with enough time before 17:00.');
    updates={techId:action.techId,start:action.start};
  } else if (action.type==='pause') {
    if (job.session!=='active') return fail('Only active work can be paused.');
    if (!action.reason.trim()) return fail('Choose a pause reason.');
    updates={session:'paused',reason:action.reason.trim()};
  } else if (action.type==='start') {
    if (job.session==='completed' || job.session==='active') return fail('This job is already active or completed.');
    const prerequisites=getPrerequisites(state,job);
    if (prerequisites.length) return fail(`Blocked by: ${prerequisites.map(j=>j.title).join(', ')}.`);
    const tech=state.technicians.find(t=>t.id===job.techId)!;
    if (state.now>=tech.breakStart && state.now<tech.breakEnd) return fail(`${tech.name} is on break until ${formatTime(tech.breakEnd)}.`);
    const rack=state.jobs.find(j=>j.resource==='rack' && j.session==='active' && j.id!==job.id);
    if (job.resource && rack) return fail('The alignment rack is occupied. Complete or pause its current job first.');
    const active=getActiveJob(state,job.techId);
    if (active && !action.pauseCurrent) return fail(`${tech.name} is already working on ${active.title}.`,active.id);
    pauseId=active?.id;
    updates={session:'active',reason:undefined};
  } else if (action.type==='complete') {
    if (job.session!=='active') return fail('Start or resume a job before completing it.');
    updates={session:'completed',reason:undefined};
  }
  const next={...state,jobs:state.jobs.map(j=>j.id===job.id?{...j,...updates}:j.id===pauseId?{...j,session:'paused' as Session,reason:'Switched to another job'}:j)};
  const messages={assign:'Assignment and planned start updated.',pause:'Job paused. Your active time is preserved.',start:'Job started. Active time is running.',complete:'Job completed. Dependent jobs are now rechecked.'};
  return {ok:true,state:next,message:messages[action.type]};
}
