import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAction, createDemoState, getReadiness, getPromiseRisk, type ShopAction, type ShopState } from '../src/components/mockups/workflow/_shared/model';
import summary from '../src/components/mockups/workflow/_shared/burnett-summary.json';

function step(state: ShopState, action: ShopAction) {
  const result = applyAction(state, action);
  assert.equal(result.ok, true, result.message);
  return result.state;
}
test('parts pause, reassignment, dependency release and reset are deterministic', () => {
  const seed = createDemoState();
  let state = step(seed, { type: 'pause', jobId: 'j1', reason: 'Waiting for parts' });
  state = step(state, { type: 'advance' });
  assert.equal(state.jobs[0].activeMinutes, 22);
  assert.equal(state.jobs[0].waitingMinutes, 15);
  assert.equal(seed.jobs[0].session, 'active', 'input must be immutable');
  state = step(state, { type: 'assign', jobId: 'j5', techId: 't2', start: 630 });
  state = step(state, { type: 'start', jobId: 'j1' });
  state = step(state, { type: 'complete', jobId: 'j1' });
  assert.equal(getReadiness(state, state.jobs[1]), 'ready');
  assert.equal(getReadiness(state, state.jobs[2]), 'blocked');
  state = step(state, { type: 'start', jobId: 'j5' });
  const conflict = applyAction(state, { type: 'start', jobId: 'j2' });
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.conflictingJobId, 'j5');
  state = step(state, { type: 'start', jobId: 'j2', pauseCurrent: true });
  assert.equal(state.jobs.find(j => j.id === 'j5')?.session, 'paused');
  assert.equal(state.jobs.filter(j => j.techId === 't2' && j.session === 'active').length, 1);
  assert.deepEqual(step(state, { type: 'reset' }), seed);
});
test('invalid state transitions and assignments fail without mutation', () => {
  const seed = createDemoState();
  for (const action of [
    {type:'start',jobId:'j2'},
    {type:'complete',jobId:'j2'},
    {type:'pause',jobId:'j1',reason:''},
    {type:'assign',jobId:'j1',techId:'t2',start:660},
    {type:'assign',jobId:'j5',techId:'missing',start:660},
    {type:'assign',jobId:'j5',techId:'t2',start:631},
    {type:'assign',jobId:'j5',techId:'t2',start:1020},
  ] as ShopAction[]) {
    const result = applyAction(seed, action);
    assert.equal(result.ok, false);
    assert.equal(result.state, seed);
  }
});
test('clock grows only active or paused sessions; delay changes promise forecast', () => {
  const seed = createDemoState();
  const paused = step(seed, {type:'pause',jobId:'j1',reason:'Waiting for parts'});
  assert.ok(getPromiseRisk(paused,'v1').finish >= getPromiseRisk(seed,'v1').finish);
  const later = step(paused, {type:'advance',minutes:180});
  assert.equal(later.jobs[0].waitingMinutes,180);
  assert.equal(later.jobs[6].activeMinutes,192);
  assert.equal(later.jobs[1].activeMinutes,0);
  assert.equal(getPromiseRisk(later,'v1').level,'risk');
});
test('break and rack constraints prevent invalid starts', () => {
  const seed = createDemoState();
  const onBreak = {...seed,now:720};
  assert.equal(applyAction(onBreak,{type:'start',jobId:'j13'}).ok,false);
  const prepared = {...seed,jobs:seed.jobs.map(j => ['j1','j2','j13'].includes(j.id) ? {...j,session:'completed' as const} : j)};
  const rack = step(prepared,{type:'start',jobId:'j3'});
  const other = applyAction(rack,{type:'start',jobId:'j14',pauseCurrent:true});
  assert.equal(other.ok,false);
  assert.match(other.message,/rack is occupied/);
});

test('Burnett presentation uses reviewed historical references, not historical customers or times', () => {
  const seed = createDemoState('burnett');
  assert.equal(seed.demoMode, 'burnett');
  assert.equal(seed.technicians.length,6);
  assert.equal(seed.vehicles.length,10);
  assert.equal(seed.jobs.filter(j=>j.sourcePackage).length,23);
  for (const tech of seed.technicians) {
    assert.ok(summary.technicians.some(t=>t.name===tech.name));
    assert.ok(seed.jobs.filter(j=>j.techId===tech.id && j.session==='active').length<=1);
  }
  for (const vehicle of seed.vehicles) {
    assert.match(vehicle.owner,/^Demo customer \d{2}$/);
    assert.match(vehicle.ro,/^DEMO-/);
  }
  for (const job of seed.jobs) {
    if (job.sourcePackage) assert.ok(summary.catalog.some(p=>p.name===job.sourcePackage));
    assert.equal(job.predicted,createDemoState().jobs.find(j=>j.id===job.id)!.predicted);
  }
  let state=step(seed,{type:'complete',jobId:'j1'});
  assert.equal(getReadiness(state,state.jobs.find(j=>j.id==='j2')!), 'ready');
  assert.deepEqual(step(state,{type:'reset'}),seed);
});

test('historical summary preserves evidence limits and contains only approved fields', () => {
  assert.equal(summary.rawRows,28110);
  assert.equal(summary.invoiceNumbers,8259);
  assert.equal(summary.creditRows,46);
  assert.equal(summary.duplicateRows,72);
  assert.equal(summary.hoursMatchPercent,99.78);
  assert.equal(summary.technicians.length,19);
  assert.equal(summary.from,'2026-01-02');
  assert.equal(summary.through,'2026-10-07');
  for (const tech of summary.technicians) {
    assert.deepEqual(Object.keys(tech).sort(),['name','firstDate','lastDate','invoiceCount','categories','packages'].sort());
  }
  for (const aliases of summary.aliases) {
    for (const name of aliases) assert.ok(summary.technicians.some(t=>t.name===name), 'aliases must remain separate');
  }
  const serialized=JSON.stringify(summary);
  assert.doesNotMatch(serialized,/@|\"VIN\"|\"Phone|\"Street\"|\"Plate\"|\"Email\"|\"Work Order #\"/);
  const alignment=summary.technicians.find(t=>t.name==='Jason Roby')!.packages.find(p=>p.name==='All Wheel Alignment')!;
  assert.equal(alignment.count,811);
});
