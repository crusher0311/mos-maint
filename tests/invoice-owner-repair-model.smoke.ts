import assert from "node:assert/strict";
import {planOwnerStructure} from "../scripts/invoice-owner-repair-model";
const snapshot={issues:[],nodes:[{record:"mixed",shop:1,sourceIds:["a","b"],desired:[
  {owner:"a",numbers:["1"]},{owner:"b",numbers:["2"]}]}],children:[
  {table:"normalized_service_jobs",id:"j",parent:"mixed",shop:1,owner:"a",job:null,immutableHash:"a".repeat(64)},
  {table:"normalized_line_items",id:"l",parent:"mixed",shop:1,owner:"a",job:"j",immutableHash:"b".repeat(64)}]};
assert.equal(planOwnerStructure(snapshot).parents.length,2);
for(const change of [
  (s:any)=>s.children[0].owner=null,
  (s:any)=>s.children[1].owner="b",
  (s:any)=>s.children[1].job="missing",
  (s:any)=>s.children[0].shop=2,
  (s:any)=>s.nodes[0].desired[1].numbers=["1"],
  (s:any)=>s.nodes[0].desired[0].numbers.push("3"),
  (s:any)=>s.children.push(s.children[0]),
  (s:any)=>s.issues.push("missing_source"),
]){
  const bad=structuredClone(snapshot);change(bad);assert.throws(()=>planOwnerStructure(bad));
}
console.log("PASS owner repair model rejects ambiguous numbers, unknown/cross-shop owners and broken job links");
