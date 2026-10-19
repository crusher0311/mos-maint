import assert from "node:assert/strict";
/** Structural proposal only. Does not establish financial values or mutate a store. */
export function planOwnerStructure(snapshot:any) {
  assert.deepEqual(snapshot.issues,[]);
  const nodes=new Map<string,any>(),owners=new Map<string,any>(),numbers=new Map<string,string>();
  for(const node of snapshot.nodes){
    assert.ok(!nodes.has(node.record),"Duplicate original parent");
    nodes.set(node.record,node);
    assert.ok(node.sourceIds.length>0);
    for(const source of node.sourceIds){
      const candidates=node.desired.filter((d:any)=>d.owner===source);
      assert.equal(candidates.length,1,"Missing or duplicate owner evidence");
      assert.equal(candidates[0].numbers.length,1,"Conflicting work-order numbers");
      const number=candidates[0].numbers[0],key=`${node.shop}:${number}`;
      assert.ok(!numbers.has(key)||numbers.get(key)===source,"Two identities claim one number");
      assert.ok(!owners.has(source),"Provider identity appears under multiple parents");
      owners.set(source,{owner:source,shop:node.shop,number,original:node.record});
      numbers.set(key,source);
    }
  }
  const seen=new Set<string>(),jobs=new Map<string,any>();
  for(const child of snapshot.children){
    assert.ok(["normalized_service_jobs","normalized_line_items","normalized_payments"].includes(child.table));
    const key=`${child.table}:${child.id}`;
    assert.ok(!seen.has(key),"Duplicate child identity");seen.add(key);
    const original=nodes.get(child.parent),owner=owners.get(child.owner);
    assert.ok(original&&owner,"Unknown child ownership");
    assert.equal(original.shop,child.shop);assert.equal(owner.shop,child.shop);
    assert.ok(original.sourceIds.includes(child.owner),"Child assigned outside its parent evidence");
    assert.match(child.immutableHash,/^[a-f0-9]{64}$/);
    if(child.table==="normalized_service_jobs")jobs.set(child.id,child);
  }
  for(const child of snapshot.children)if(child.table==="normalized_line_items"){
    const job=jobs.get(child.job);
    assert.ok(job,"Line references a missing job");
    assert.equal(job.owner,child.owner,"Line/job ownership disagreement");
    assert.equal(job.shop,child.shop);
  }
  return {parents:[...owners.values()],children:snapshot.children};
}
