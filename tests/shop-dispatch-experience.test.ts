import test from "node:test";
import assert from "node:assert/strict";
import { assessJobExperience, parseExperienceHistory, type ExperienceHistory } from "../lib/shop-dispatch/experience";
import type { Job, Technician } from "../lib/shop-dispatch/model";

const job = {title:"  Wheel   alignment ",operations:{requiredSkills:[]}} as unknown as Job;
const tech:Technician={id:"t",name:"Example",email:"",active:true};
function history(count:number,shared=0):ExperienceHistory{
  return parseExperienceHistory({truncated:false,profiles:[{technicianId:"t",skills:[{
    key:"wheel alignment",title:"Wheel alignment",count,sharedJobCount:shared,lastCompletedAt:null,
    evidence:[{ro:"TEST",title:"Wheel alignment",completedAt:null,shared:shared>0}],
  }]}]});
}
test("experience is an exact normalized-title advisory with a disclosed threshold",()=>{
  assert.equal(assessJobExperience(job,tech,history(1)).level,"limited");
  assert.equal(assessJobExperience(job,tech,history(2)).level,"limited");
  assert.equal(assessJobExperience(job,tech,history(3)).level,"established");
  const shared=assessJobExperience(job,tech,history(8,7));
  assert.equal(shared.count,1);assert.equal(shared.level,"limited");
  assert.match(shared.message,/7 shared/);
  assert.equal(assessJobExperience({...job,title:"Headlamp alignment"},tech,history(10)).level,"unknown");
  assert.equal(assessJobExperience(job,{...tech,id:"other"},history(10)).level,"unknown");
});
test("missing, partial and failed history are disclosed without inventing qualifications",()=>{
  for(const status of ["loading","error"] as const){
    const result=assessJobExperience(job,tech,{...history(99),status});
    assert.equal(result.level,"unknown");assert.equal(result.count,null);
  }
  const partial=assessJobExperience(job,tech,{...history(1),truncated:true});
  assert.match(partial.message,/incomplete/);
  assert.equal(assessJobExperience(job,tech,history(0)).level,"unknown");
});
test("manager assessments stay separate from inferred history",()=>{
  const reviewed={...tech,skills:[{key:"wheel alignment",title:"Wheel alignment",status:"confirmed" as const,notes:"",reviewedAt:"",reviewedBy:"manager"}]};
  const result=assessJobExperience(job,reviewed,history(1));
  assert.equal(result.confirmed,true);assert.equal(result.level,"limited");
  assert.equal(assessJobExperience(job,{...reviewed,skills:[{...reviewed.skills[0],status:"not-qualified"}]},history(99)).level,"not-qualified");
});
test("history parser fails closed on malformed or contradictory evidence",()=>{
  assert.throws(()=>parseExperienceHistory({profiles:[],truncated:"false"}));
  assert.throws(()=>parseExperienceHistory({profiles:[{technicianId:"t",skills:[{count:-1}]}],truncated:false}));
  assert.throws(()=>history(1,2));
});
