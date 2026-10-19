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
import {aggregateInvoiceHours, combineInvoiceLocationDiagnostics} from "../lib/invoice-hours-contract";
import {INVOICE_HOURS_SQL, INVOICE_HOURS_MAX_ORDERS} from "../lib/invoice-hours-query";
import {invoiceHoursDisplay} from "../lib/invoice-hours-display";
import {INVOICE_FLEET_PROTOTYPE_SQL,invoiceFleetPrototypeParams,invoiceFleetPrototypeResult} from "../scripts/invoice-fleet-sql-prototype";
import {admitInvoiceFleet} from "../lib/invoice-fleet-admission";

test("location diagnostic ratios use raw totals and preserve independent vetoes",()=>{
  const summary=(count:number,hours:number)=>({
    invoiceEvidenceCapped:0,invoiceCount:count,invoicePopulationUnknown:0,
    invoiceSoldHours:hours,invoicePresentedHours:hours,
    invoiceSoldCovered:count,invoicePresentedCovered:count,
    averageSoldHoursPerInvoice:count?hours/count:null,
    averagePresentedHoursPerInvoice:count?hours/count:null,
  });
  const rows=new Map([[1,summary(1,2)],[2,summary(99,396)],[3,summary(0,0)]]);
  assert.equal(combineInvoiceLocationDiagnostics([1,2,3],rows).averageSoldHoursPerInvoice,3.98);
  rows.get(1)!.averagePresentedHoursPerInvoice=null;
  const partial=combineInvoiceLocationDiagnostics([1,2,3],rows);
  assert.equal(partial.averagePresentedHoursPerInvoice,null);
  assert.equal(partial.averageSoldHoursPerInvoice,3.98);
  assert.throws(()=>combineInvoiceLocationDiagnostics([1,2,3,4],rows));
  assert.throws(()=>combineInvoiceLocationDiagnostics([1,2,2],rows));
});

test("fleet admission is database-global, read-only, and released on commit or timeout",async()=>{
  const socket=process.env.INVOICE_OWNER_TEST_SOCKET;
  assert.match(socket??"",/^\/tmp\/invoice-owner-offline\.[A-Za-z0-9]+$/);
  const pg=postgres({host:socket,port:5432,username:userInfo().username,database:"postgres",max:2,onnotice:()=>{}});
  const admit=(tx:any)=>admitInvoiceFleet((text,params)=>tx.unsafe(text,params));
  try{
    await pg.begin(async tx=>{
      await admit(tx);
      assert.equal((await tx.unsafe("SHOW transaction_read_only"))[0].transaction_read_only,"on");
      assert.equal((await tx.unsafe("SHOW temp_file_limit"))[0].temp_file_limit,"64MB");
      await assert.rejects(pg.begin(async other=>{await admit(other);}),/Another fleet invoice report/);
    });
    await assert.rejects(pg.begin(async tx=>{
      await admit(tx);
      await tx.unsafe("CREATE TABLE forbidden_fleet_write(id int)");
    }),e=>(e as any).code==="25006");
    await assert.rejects(pg.begin(async tx=>{
      await admit(tx);await tx.unsafe("SET LOCAL statement_timeout='10ms'");
      await tx.unsafe("SELECT pg_sleep(1)");
    }),e=>(e as any).code==="57014");
    await pg.begin(async tx=>{await admit(tx);});
  }finally{await pg.end();}
});

test("large fleet remains capped; bounded offline location aggregates retain unknowns and identity conflicts",async()=>{
  const socket=process.env.INVOICE_OWNER_TEST_SOCKET;
  assert.match(socket??"",/^\/tmp\/invoice-owner-offline\.[A-Za-z0-9]+$/);
  const pg=postgres({host:socket,port:5432,username:userInfo().username,database:"postgres",max:1,onnotice:()=>{}});
  const shops=Array.from({length:10},(_,i)=>i+1);
  const start="2026-09-01T00:00:00.000Z",end="2026-09-30T23:59:59.999Z";
  try{
    await pg`CREATE TEMP TABLE normalized_work_orders(id text,shop_id int,status text,soft_delete jsonb,provenance jsonb,custom_fields jsonb)`;
    await pg`SET statement_timeout='10s'`;
    await pg`INSERT INTO normalized_work_orders
      SELECT n::text,1+(n-1)/21000,'closed',null,
        '{"sourceSystem":"protractor","sourceIds":[]}'::jsonb,null
      FROM generate_series(1,210000) n`;
    // The second copy is outside the date range, but must still veto the first.
    await pg`INSERT INTO normalized_work_orders
      SELECT 'peer-'||n,1,'invoiced',null,
        '{"sourceSystem":"protractor","sourceIds":[{"system":"protractor","idType":"invoice_id","idValue":"00000000-0000-0000-0000-000000000001"}]}'::jsonb,
        jsonb_build_object('invoiceHours',jsonb_build_object('version',1,
          'id','00000000-0000-0000-0000-000000000001','date',
          CASE WHEN n=1 THEN '2026-09-02T00:00:00.000Z' ELSE '2020-01-01T00:00:00.000Z' END,
          'sold',2,'presented',3))
      FROM generate_series(1,2) n`;
    await pg`INSERT INTO normalized_work_orders VALUES ('unauthorized',99,'closed',null,'{}',null)`;
    // Disposable fixture indexes only; not production guidance.
    await pg`CREATE INDEX ON normalized_work_orders(shop_id)`;
    await pg`CREATE INDEX ON normalized_work_orders(shop_id,(lower(custom_fields->'invoiceHours'->>'id')))`;
    const query=(ids:number[])=>pg.unsafe(INVOICE_HOURS_SQL,[`{${ids.join(",")}}`,start,end]);
    const summarize=(rows:any)=>aggregateInvoiceHours(rows,new Date(start),new Date(end)).summary;
    const fleet=await query(shops);
    assert.equal(fleet.length,INVOICE_HOURS_MAX_ORDERS+1);
    const capped=summarize(fleet);
    assert.equal(capped.invoiceEvidenceCapped,1);
    for(const key of ["invoiceCount","invoicePopulationUnknown","invoiceSoldHours","invoicePresentedHours",
      "averageSoldHoursPerInvoice","averagePresentedHoursPerInvoice"] as const)assert.equal(capped[key],null);
    assert.match(invoiceHoursDisplay("averageSoldHoursPerInvoice",capped)!,/Coverage capped/);
    const locations=new Map<number,ReturnType<typeof summarize>>();
    for(const shop of shops){
      const rows=await query([shop]);
      assert.ok(rows.every(row=>row.shop_id===shop));
      locations.set(shop,summarize(rows));
    }
    const combined=combineInvoiceLocationDiagnostics(shops,locations);
    assert.equal(combined.invoicePopulationUnknown,210001);
    assert.equal(combined.invoiceCount,0);
    assert.equal(combined.averageSoldHoursPerInvoice,null);
    assert.equal(combined.averagePresentedHoursPerInvoice,null);
    assert.equal(combined.invoiceEvidenceCapped,0);
    // Single-query offline prototype: bound server spill and app output rather
    // than loading the fleet representations or making one query per shop.
    await pg`SET work_mem='2MB'`;
    await pg`SET hash_mem_multiplier=1`;
    await pg`SET temp_file_limit='64MB'`;
    await pg`SET max_parallel_workers_per_gather=0`;
    const params=invoiceFleetPrototypeParams(shops,shops,new Date(start),new Date(end));
    assert.throws(()=>invoiceFleetPrototypeParams(shops,[99],new Date(start),new Date(end)));
    assert.throws(()=>invoiceFleetPrototypeParams(shops,[1,1],new Date(start),new Date(end)));
    const prototype=await pg.begin(async tx=>{
      await admitInvoiceFleet((text,values)=>tx.unsafe(text,values as any[]));
      await tx.unsafe("SET LOCAL statement_timeout='10s'");
      return tx.unsafe(INVOICE_FLEET_PROTOTYPE_SQL,params);
    });
    assert.equal(prototype.length,10);
    assert.ok(Buffer.byteLength(JSON.stringify(prototype))<8192);
    assert.deepEqual(invoiceFleetPrototypeResult(shops,prototype).summary,combined);
    assert.throws(()=>invoiceFleetPrototypeResult(shops,prototype.slice(1)));
    assert.throws(()=>combineInvoiceLocationDiagnostics([1],locations),/authorized location/);
    locations.set(1,capped);
    assert.deepEqual(combineInvoiceLocationDiagnostics(shops,locations),capped);
    // One oversized location must not be paged or treated as complete.
    await pg`UPDATE normalized_work_orders SET shop_id=1 WHERE shop_id<=10`;
    assert.equal(summarize(await query([1])).invoiceEvidenceCapped,1);
    const oversized=await pg.unsafe(INVOICE_FLEET_PROTOTYPE_SQL,
      invoiceFleetPrototypeParams([1],[1],new Date(start),new Date(end)));
    assert.deepEqual(invoiceFleetPrototypeResult([1],oversized).summary,combined);
    await pg`SET statement_timeout='1ms'`;
    await assert.rejects(pg.unsafe(INVOICE_FLEET_PROTOTYPE_SQL,params),e=>(e as any).code==="57014");
  }finally{await pg.end();}
});

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
    for(const [first,last,expectedReport] of [[from,until,all],[start,end,period]] as const){
      const sqlRows=await pg.unsafe(INVOICE_FLEET_PROTOTYPE_SQL.replaceAll("normalized_work_orders","proposed_work_orders"),
        invoiceFleetPrototypeParams([1,2],[1,2],new Date(first),new Date(last)));
      const sqlReport=invoiceFleetPrototypeResult([1,2],sqlRows);
      assert.deepEqual(sqlReport.summary,expectedReport.summary);
      for(const id of [1,2])assert.deepEqual(sqlReport.locations.get(id),expectedReport.locations.get(String(id)));
    }
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

test("SQL prototype preserves duplicate hour vetoes, alias resolution and weighted averages",async()=>{
  const socket=process.env.INVOICE_OWNER_TEST_SOCKET;
  assert.match(socket??"",/^\/tmp\/invoice-owner-offline\.[A-Za-z0-9]+$/);
  const pg=postgres({host:socket,port:5432,username:userInfo().username,database:"postgres",max:1,onnotice:()=>{}});
  const start=new Date("2026-09-01T00:00:00.000Z"),end=new Date("2026-09-30T23:59:59.999Z");
  const id=(n:number)=>`00000000-0000-0000-0000-${String(n).padStart(12,"0")}`;
  try{
    await pg`CREATE TEMP TABLE normalized_work_orders(id text PRIMARY KEY,shop_id int,status text,soft_delete jsonb,provenance jsonb,custom_fields jsonb)`;
    const put=async(row:string,shop:number,identity:number,sold:number|null,presented:number|null,evidence=true)=>{
      const sourceIds=[{system:"protractor",idType:"invoice_id",idValue:id(identity)}];
      await pg`INSERT INTO normalized_work_orders VALUES(${row},${shop},'invoiced','{}',
        ${pg.json({sourceSystem:"protractor",sourceIds})},
        ${pg.json(evidence?{invoiceHours:{version:1,id:id(identity),date:"2026-09-12T00:00:00.000Z",sold,presented}}:{})})`;
    };
    await put("a",1,1,2,4);await put("a-copy",1,1,2,4);
    await put("a-unknown",1,1,null,null,false);
    await put("b",2,2,10,12);await put("c",2,3,6,8);
    const compare=async()=>{
      const params=invoiceFleetPrototypeParams([1,2],[1,2],start,end);
      const existing=aggregateInvoiceHours(await pg.unsafe(INVOICE_HOURS_SQL,params) as any,start,end);
      const result=invoiceFleetPrototypeResult([1,2],await pg.unsafe(INVOICE_FLEET_PROTOTYPE_SQL,params));
      assert.deepEqual(result.summary,existing.summary);
      return result.summary;
    };
    assert.equal((await compare()).averageSoldHoursPerInvoice,6);
    await put("b-partial",2,2,10,null);
    let summary=await compare();
    assert.equal(summary.averageSoldHoursPerInvoice,6);
    assert.equal(summary.averagePresentedHoursPerInvoice,null);
    await put("c-conflict",2,3,7,8);
    summary=await compare();
    assert.equal(summary.averageSoldHoursPerInvoice,null);
    assert.equal(summary.invoiceSoldCovered,2);
    for(const n of [101,102]){
      await pg`INSERT INTO normalized_work_orders VALUES(${'alias-'+n},1,'closed','{}',
        ${pg.json({sourceSystem:"protractor",sourceIds:[100,n].map(v=>({
          system:"protractor",idType:"invoice_id",idValue:id(v),
        }))})},'{}')`;
    }
    const params=invoiceFleetPrototypeParams([1,2],[1,2],start,end);
    const ambiguous=await pg.unsafe(INVOICE_FLEET_PROTOTYPE_SQL,params);
    assert.throws(()=>invoiceFleetPrototypeResult([1,2],ambiguous),/ambiguous or unsupported/);
    await pg`DELETE FROM normalized_work_orders WHERE id LIKE 'alias-%'`;
    await pg`UPDATE normalized_work_orders SET custom_fields=
      jsonb_set(custom_fields,'{invoiceHours,version}','9') WHERE id='a'`;
    const unsupported=await pg.unsafe(INVOICE_FLEET_PROTOTYPE_SQL,params);
    assert.throws(()=>invoiceFleetPrototypeResult([1,2],unsupported),/ambiguous or unsupported/);
    await pg`TRUNCATE normalized_work_orders`;
    await pg`INSERT INTO normalized_work_orders
      SELECT n::text,1,'invoiced','{}',
        jsonb_build_object('sourceSystem','protractor','sourceIds',jsonb_build_array(
          jsonb_build_object('system','protractor','idType','invoice_id','idValue',
            '00000000-0000-0000-0000-'||lpad(n::text,12,'0')))),
        jsonb_build_object('invoiceHours',jsonb_build_object('version',1,
          'id','00000000-0000-0000-0000-'||lpad(n::text,12,'0'),
          'date','2026-09-12T00:00:00.000Z','sold',1,'presented',2))
      FROM generate_series(1,8000) n`;
    await pg`INSERT INTO normalized_work_orders
      SELECT 'alias-'||n,1,'closed','{}',
        jsonb_build_object('sourceSystem','protractor','sourceIds',jsonb_build_array(
          jsonb_build_object('system','protractor','idType','invoice_id','idValue','alias-'||n),
          jsonb_build_object('system','protractor','idType','invoice_id','idValue',
            '00000000-0000-0000-0000-'||lpad(n::text,12,'0')))),'{}'
      FROM generate_series(1,8000) n`;
    await pg`CREATE INDEX ON normalized_work_orders(shop_id,(lower(custom_fields->'invoiceHours'->>'id')))`;
    await pg`ANALYZE normalized_work_orders`;
    const many=await pg.begin(async tx=>{
      await admitInvoiceFleet((text,values)=>tx.unsafe(text,values as any[]));
      await tx.unsafe("SET LOCAL statement_timeout='10s'");
      return tx.unsafe(INVOICE_FLEET_PROTOTYPE_SQL,params);
    });
    const manySummary=invoiceFleetPrototypeResult([1,2],many).summary;
    assert.equal(manySummary.invoiceCount,8000);
    assert.equal(manySummary.invoicePopulationUnknown,0);
    assert.equal(manySummary.averageSoldHoursPerInvoice,1);
    assert.equal(manySummary.averagePresentedHoursPerInvoice,2);
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
