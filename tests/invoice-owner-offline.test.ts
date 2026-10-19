import assert from "node:assert/strict";
import {test} from "node:test";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import dns from "node:dns";
import postgres from "postgres";
import {userInfo} from "node:os";
import {ownerFixture} from "./fixtures/invoice-owner";
import {planOwnerStructure} from "../scripts/invoice-owner-repair-model";
import {reconcileOwnerCopies,queryOwnerReport,assertOwnerFinancialControl} from "../scripts/invoice-owner-report-model";

test("offline guard rejects network and source credentials are absent",async()=>{
  for(const key of Object.keys(process.env))assert.doesNotMatch(key,/PASSWORD|SECRET|API_KEY|DATABASE_URL|MONGODB/);
  for(const host of ["127.0.0.1","203.0.113.1","example.invalid"]){
    assert.throws(()=>net.connect(443,host),/offline network denied/);
    assert.throws(()=>new net.Socket().connect({host,port:443}),/offline network denied/);
    assert.throws(()=>tls.connect({host,port:443}),/offline network denied/);
    assert.throws(()=>http.get(`http://${host}`),/offline network denied/);
    assert.throws(()=>https.get(`https://${host}`),/offline network denied/);
    assert.throws(()=>dns.lookup(host,()=>{}),/offline network denied/);
    await assert.rejects(fetch(`https://${host}`),/offline network denied/);
  }
});

test("mixed owners preserve every child; ambiguous or cross-shop assignments fail closed",()=>{
  const {snapshot}=ownerFixture(),before=structuredClone(snapshot);
  const plan=planOwnerStructure(snapshot);
  assert.equal(plan.parents.length,8);
  assert.deepEqual(plan.children,before.children);
  assert.deepEqual(snapshot,before);
  for(const mutate of [
    (s:any)=>s.nodes[0].desired[1].numbers=["1"],
    (s:any)=>s.nodes[0].desired[0].numbers.push("other"),
    (s:any)=>s.children[0].shop=2,
    (s:any)=>s.children[0].owner=s.nodes.find((n:any)=>n.shop===2).sourceIds[0],
    (s:any)=>s.children[1].owner=s.nodes[0].sourceIds[1],
    (s:any)=>s.children[1].job="absent",
    (s:any)=>s.children.push(s.children[0]),
    (s:any)=>s.issues.push("unresolved"),
  ]){
    const bad=structuredClone(snapshot);mutate(bad);
    assert.throws(()=>planOwnerStructure(bad));
  }
});

test("real invoice SQL retains owner totals, unknowns, dates and deletion semantics",async()=>{
  const socket=process.env.INVOICE_OWNER_TEST_SOCKET;
  assert.match(socket??"",/^\/tmp\/invoice-owner-offline\.[A-Za-z0-9]+$/);
  const pg=postgres({host:socket,port:5432,username:userInfo().username,database:"postgres",max:1,onnotice:()=>{}});
  try{
    assert.equal((await pg`select current_setting('invoice_preview.disposable',true) marker`)[0].marker,"yes");
    await pg`CREATE TABLE normalized_work_orders(id text PRIMARY KEY,shop_id int,status text,soft_delete jsonb,provenance jsonb,custom_fields jsonb)`;
    await pg`CREATE TABLE proposed_work_orders(LIKE normalized_work_orders INCLUDING ALL)`;
    const {snapshot,owners}=ownerFixture(),original=structuredClone({snapshot,owners});
    const plan=planOwnerStructure(snapshot);
    for(const parent of snapshot.nodes){
      const provenance={sourceSystem:"protractor",sourceIds:parent.sourceIds.map(id=>({system:"protractor",idType:"work_order_id",idValue:id}))};
      await pg`insert into normalized_work_orders values(${parent.record},${parent.shop},'unknown','{}',${pg.json(provenance)},'{}')`;
    }
    for(const owner of plan.parents){
      const fixture=owners.find(o=>o.id===owner.owner)!;
      // Feed every copy on the original parent, not just this owner's copies.
      const siblings=owners.filter(o=>plan.parents.some(p=>p.owner===o.id&&p.original===owner.original));
      const result=reconcileOwnerCopies(owner.owner,siblings.flatMap(o=>o.payloads));
      assert.equal(result.reason,fixture.reason);
      if(result.evidence)assert.equal(result.evidence.id,owner.owner);
      const provenance={sourceSystem:"protractor",sourceIds:[{system:"protractor",idType:"invoice_id",idValue:owner.owner}]};
      await pg`insert into proposed_work_orders values(${owner.owner},${owner.shop},${result.evidence?"invoiced":"unknown"},
        ${pg.json({isDeleted:fixture.deleted})},${pg.json(provenance)},${pg.json({invoiceHours:result.evidence})})`;
    }
    const from="1900-01-01T00:00:00.000Z",until="9999-12-31T23:59:59.999Z";
    const start="2026-09-18T00:00:00.000Z",end="2026-10-17T23:59:59.999Z";
    const before=await queryOwnerReport(pg,"normalized_work_orders",[1,2],from,until);
    assert.equal(before.summary.invoiceSoldHours,0);
    assert.equal(before.summary.averageSoldHoursPerInvoice,null);
    const all=await queryOwnerReport(pg,"proposed_work_orders",[1,2],from,until);
    // Independent literal financial oracle, NOT totals computed by reconciliation.
    assertOwnerFinancialControl(all.summary,{invoices:5,sold:50,presented:62});
    assert.equal(all.summary.invoicePopulationUnknown,2);
    assert.equal(all.summary.averageSoldHoursPerInvoice,null);
    assert.equal(all.summary.averagePresentedHoursPerInvoice,null);
    assertOwnerFinancialControl(all.locations.get("1")!,{invoices:4,sold:37,presented:45});
    assertOwnerFinancialControl(all.locations.get("2")!,{invoices:1,sold:13,presented:17});
    assert.equal(all.locations.get("2")?.averageSoldHoursPerInvoice,13);
    const period=await queryOwnerReport(pg,"proposed_work_orders",[1,2],start,end);
    assertOwnerFinancialControl(period.summary,{invoices:3,sold:22,presented:30});
    assert.equal(period.summary.invoicePopulationUnknown,2);
    assert.equal(period.summary.averageSoldHoursPerInvoice,null);
    assert.equal(period.summary.averagePresentedHoursPerInvoice,null);
    assert.equal(period.rows.length,5);
    // Global totals alone cannot detect a transfer between owners.
    const expected=new Map([
      [owners[0].id,[2,5]],[owners[1].id,[7,8]],[owners[5].id,[11,13]],
      [owners[6].id,[13,17]],[owners[7].id,[17,19]],
    ]);
    for(const row of all.rows){
      if(expected.has(row.id))assert.deepEqual([row.invoice_evidence?.sold,row.invoice_evidence?.presented],expected.get(row.id));
      else assert.equal(row.invoice_evidence,null);
    }
    assert.deepEqual(all.rows.filter(r=>r.invoice_evidence).map(r=>r.id).sort(),[...expected.keys()].sort());
    assert.ok(!all.rows.some(r=>r.id===owners[4].id),"Soft-deleted hours must not leak");
    const onlyOtherShop=await queryOwnerReport(pg,"proposed_work_orders",[2],from,until);
    assert.deepEqual(onlyOtherShop.rows.map(r=>r.id),[owners[6].id]);
    assert.throws(()=>assertOwnerFinancialControl(all.summary,{invoices:5,sold:51,presented:62}));
    assert.throws(()=>reconcileOwnerCopies("missing",owners[0].payloads),/Missing owner payload/);
    assert.deepEqual({snapshot,owners},original,"No source or child data mutated");
  }finally{await pg.end();}
});

test("missing numbers and contradictory source versions never borrow a sibling's evidence",()=>{
  const {owners}=ownerFixture();
  const [first,second,missing,conflicting]=owners;
  assert.equal(reconcileOwnerCopies(first.id,[...first.payloads,...second.payloads]).evidence?.sold,2);
  assert.equal(reconcileOwnerCopies(second.id,[...first.payloads,...second.payloads]).evidence?.sold,7);
  const absent={...missing.payloads[0],InvoiceNumber:undefined};
  assert.equal(reconcileOwnerCopies(missing.id,[absent,...first.payloads]).evidence,null);
  for(const copies of [conflicting.payloads,[...conflicting.payloads].reverse()]){
    const result=reconcileOwnerCopies(conflicting.id,[...copies,...first.payloads]);
    assert.equal(result.reason,"conflicting_evidence");
    assert.equal(result.evidence,null);
  }
  assert.equal(reconcileOwnerCopies(first.id,[...first.payloads,...first.payloads]).evidence?.sold,2);
});
