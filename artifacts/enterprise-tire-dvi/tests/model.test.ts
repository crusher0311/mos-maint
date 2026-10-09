import test from 'node:test';
import assert from 'node:assert/strict';
import {applyAction, createDemoState, composeInspectionLines, getCompletionErrors, getPricingErrors, isReviewed, ticketTotal} from '../src/model';

test('mandatory green documentation, stable lines, review invalidation and reset', () => {
  let s=createDemoState();
  assert.equal(applyAction(s,{type:'complete'}).ok,false);
  assert.equal(applyAction(s,{type:'toggle-check',id:'safety-0'}).ok,false);
  s=applyAction(s,{type:'sample-green'}).state;
  assert.equal(getCompletionErrors(s).length,0);
  assert.equal(composeInspectionLines(s).length,7);
  assert.ok(composeInspectionLines(s).every(l=>l.mandatory && l.inspected));
  assert.ok(s.wheels.every(w=>w.afterPsi===''));
  assert.notEqual(s.wheels[0].size,s.wheels[2].size);
  s=applyAction(s,{type:'complete'}).state;
  s=applyAction(s,{type:'review'}).state;
  assert.ok(isReviewed(s));
  assert.equal(applyAction(s,{type:'handoff'}).ok,true);
  s=applyAction(s,{type:'wheel',id:'LF',patch:{notes:'Revised'}}).state;
  assert.equal(isReviewed(s),false);
  assert.equal(composeInspectionLines(s).length,7);
  assert.equal(composeInspectionLines(s)[0].notes,'Revised');
  assert.deepEqual(applyAction(s,{type:'reset'}).state,createDemoState());
});
test('units, pressure separation, missing checks and battery states',()=>{
  let s=applyAction(createDemoState(),{type:'sample-green'}).state;
  s=applyAction(s,{type:'wheel',id:'LF',patch:{beforePsi:'36'}}).state;
  assert.equal(s.wheels[0].afterPsi,'');
  s=applyAction(s,{type:'wheel',id:'LF',patch:{unit:'mm'}}).state;
  assert.equal(s.wheels[0].inner,'');
  assert.ok(getCompletionErrors(s).some(e=>e.includes('tread')));
  s=applyAction(s,{type:'sample-green'}).state;
  for(const patch of [{measuredStandard:'EN' as const},{result:'not-tested' as const},{result:'unable-to-test' as const,notes:''},{rated:'-1'}]){
    assert.ok(getCompletionErrors(applyAction(s,{type:'battery',patch}).state).length);
  }
  const unable=applyAction(s,{type:'battery',patch:{result:'unable-to-test',notes:'Tester unavailable'}}).state;
  assert.equal(getCompletionErrors(unable).length,0);
  assert.equal(composeInspectionLines(unable).find(l=>l.id==='battery')?.inspected,false);
  const low=applyAction(s,{type:'battery',patch:{measured:'100',result:'pass'}}).state;
  assert.equal(low.battery.result,'pass'); // no percentage inference
  assert.ok(getCompletionErrors(applyAction(s,{type:'wheel',id:'RR',patch:{afterPsi:'121'}}).state).length);
});
test('optional statuses and pricing math',()=>{
  let s=applyAction(createDemoState(),{type:'sample-green'}).state;
  s=applyAction(s,{type:'toggle-check',id:'brake-pads'}).state;
  s=applyAction(s,{type:'check',id:'brake-pads',patch:{rating:'not-applicable'}}).state;
  assert.equal(composeInspectionLines(s).at(-1)?.inspected,false);
  s=applyAction(s,{type:'recommendation',id:'tires',patch:{selected:true}}).state;
  assert.equal(ticketTotal(s),470.5);
  s=applyAction(s,{type:'recommendation',id:'tires',patch:{quantity:'3',unitPrice:'100.25',hours:'1.5',laborRate:'120'}}).state;
  assert.equal(ticketTotal(s),480.75);
  s=applyAction(s,{type:'recommendation',id:'tires',patch:{quantity:'-1'}}).state;
  assert.ok(getPricingErrors(s).length);
});
