import assert from "node:assert/strict";
import { getAdapter } from "../lib/integrations/core/normalized-adapter";
import { laborBand, protractorLaborLineEvidence } from "../lib/labor-reporting-contract";
import { aggregateLaborFacts } from "../lib/labor-reporting-aggregate";
import { protractorInvoiceLaborEvidence } from "../lib/integrations/protractor/labor-evidence";
import { compileReportDefinition } from "../lib/report-definition-compiler";
import { getReportingKpis, normalizeReportingRange } from "../lib/reporting-kpi-service";
import { LABOR_REPORT_SQL } from "../lib/labor-reporting-query";
import { laborPartitions } from "../lib/labor-reporting-partitions";
import { providerMoneyToDollars } from "../lib/reporting-kpi-contract";
assert.deepEqual([0,.99,1,1.99,2,4,4.01,null,-1].map(laborBand),
  ["under1","under1","1to2","1to2","2to4","2to4","over4","unknown","unknown"]);
assert.equal(protractorLaborLineEvidence({ Hours: 0, EstimatedHours: 2 }).hours,0);
assert.equal(protractorLaborLineEvidence({ Total: 100, Discount: 10, ExtendedTotal: 90 }).net,90);
assert.equal(protractorLaborLineEvidence({ Total: 90, Discount: 10, ExtendedTotal: 90 }).net,null);
assert.equal(protractorLaborLineEvidence({}).hours,null);
const job = { ID: "same", Discount: 0, ServicePackageLines: [{ Type:"Labor", Hours:2, Total:100, Discount:10, ExtendedTotal:90 }] };
const finalIdentity={Type:"Invoice",WorkflowStage:"Invoice",ID:"ce321e56-bf5d-4653-a428-1c47ece1a9fc"};
const source_ids=[{system:"protractor",idValue:finalIdentity.ID}];
const raw = { ...finalIdentity, Discount:0, ServicePackages:[job], DeferredServicePackages:[job] };
assert.deepEqual(protractorInvoiceLaborEvidence(raw),{version:2,sold:0,presented:2,net:0});
assert.equal(protractorInvoiceLaborEvidence({...raw,DeferredServicePackages:[]})?.net,90);
assert.equal(protractorInvoiceLaborEvidence({...raw,Discount:undefined})?.net,null);
assert.deepEqual(protractorInvoiceLaborEvidence({...finalIdentity,ServicePackages:[job]}),{version:2,sold:null,presented:null,net:null});
for (const deferred of [undefined,null,{}]) {
  const partial = {...finalIdentity,ServicePackages:[{...job,IsInvoicing:true}],DeferredServicePackages:deferred};
  assert.deepEqual(protractorInvoiceLaborEvidence(partial),{version:2,sold:2,presented:null,net:null});
  assert.equal(protractorInvoiceLaborEvidence({...partial,ServicePackages:[{...job,IsInvoicing:false}]})?.sold,0);
  assert.equal(protractorInvoiceLaborEvidence({...partial,ServicePackages:[{...job,IsInvoicing:true,BilledHours:-1}]})?.sold,null);
  assert.equal(protractorInvoiceLaborEvidence({...partial,ServicePackages:[{...job,IsInvoicing:true,ServicePackageLines:[{Type:"Labor"}]}]})?.sold,null);
}
assert.equal(protractorInvoiceLaborEvidence({DeferredServicePackages:[]}),null);
assert.equal(protractorInvoiceLaborEvidence({...raw,ServicePackages:[{...job,IsInvoicing:true}]})?.sold,0,"known deferred twin still wins");
const partialAggregate=aggregateLaborFacts([{id:"partial",shop_id:1,provider:"protractor",source_ids,
 business_date:"2026-09-15",sold:null,presented:null,net:null,cached_source:{shopId:1,rawPayload:{
 ...finalIdentity,InvoiceTime:"2026-09-15T12:00:00Z",ServicePackages:[{...job,IsInvoicing:true}]}}}]);
assert.equal(partialAggregate.summary.soldLaborHours,2);
assert.equal(partialAggregate.summary.soldLaborCoveredROs,1);
assert.equal(partialAggregate.summary.presentedLaborHours,null);
assert.equal(partialAggregate.summary.presentedLaborCoveredROs,0);
assert.equal(partialAggregate.bands.find(b=>b.key==="2to4")?.metrics.laborClosedROCount,1);
assert.equal(protractorInvoiceLaborEvidence({...raw,ServicePackages:[{...job,Status:"Unverified"}],DeferredServicePackages:[]})?.sold,null);
assert.equal(protractorLaborLineEvidence({Total:-100,Discount:0,ExtendedTotal:-100}).net,-100);
assert.equal(providerMoneyToDollars(12500,"tekmetric"),125);
assert.equal(providerMoneyToDollars(125,"tekmetric","service_job"),125);
assert.equal(protractorInvoiceLaborEvidence({...raw,ServicePackages:[{...job,Status:"Pending"}],DeferredServicePackages:[]})?.presented,0);
const rows = [0,1,2,4,5,null].map((sold,i) => ({id:String(i),shop_id:1,provider:"protractor",source_ids,business_date:"2026-01-01",sold,presented:sold,net:null}));
const agg = aggregateLaborFacts([...rows,rows[0]]);
assert.equal(agg.summary.laborClosedROCount,6);
assert.equal(agg.summary.soldLaborHours,12);
assert.equal(agg.bands.reduce((n,b)=>n+(b.metrics.laborClosedROCount??0),0),6);
assert.equal(aggregateLaborFacts([{...rows[0],provider:"tekmetric",sold:100}]).summary.soldLaborHours,null);
const def = {version:1,id:"labor",name:"Labor",dateRange:{start:"2026-01-01",end:"2026-10-05"},metrics:["soldLaborHours"],dimensions:["soldLaborHoursBand"],presentation:{kind:"table"}};
assert.deepEqual(compileReportDefinition(def,{shopIds:[1]}).execution,{stages:["labor"],dimensions:["soldLaborHoursBand"]});
assert.throws(()=>compileReportDefinition({...def,dimensions:["technician"]},{shopIds:[1]}),/Labor metrics/);
const cache = {shopId:1,rawPayload:{...raw,InvoiceTime:"2026-01-01T12:00:00-05:00",DeferredServicePackages:[]}};
assert.equal(aggregateLaborFacts([{...rows[0],cached_source:cache}]).summary.netLaborSales,90);
assert.equal(aggregateLaborFacts([{...rows[0],cached_source:cache,has_refund:true}]).summary.netLaborSales,null);
assert.equal(aggregateLaborFacts([{...rows[0],business_date:"2026-01-02",cached_source:cache}]).summary.netLaborSales,null);
for(const patch of [{WorkflowStage:"Appointment",Status:"Pending"},{Status:"Pending"},
 {ID:"00000000-0000-0000-0000-000000000000"}]){
  const changed={...cache,rawPayload:{...cache.rawPayload,...patch}};
  assert.equal(aggregateLaborFacts([{...rows[2],cached_source:changed}]).summary.soldLaborHours,2);
  assert.equal(aggregateLaborFacts([{...rows[2],cached_source:changed}]).summary.netLaborSales,null);
}
assert.equal(aggregateLaborFacts([{...rows[2],cached_source:{...cache,shopId:2}}]).summary.netLaborSales,null);
const incomplete={...raw,DeferredServicePackages:[],ServicePackages:[{...job,IsInvoicing:true,
 ServicePackageLines:[{Type:"Labor",Hours:2},{Type:"Labor"}]}]};
assert.equal(protractorInvoiceLaborEvidence(incomplete)?.sold,null);
const incompleteJob=getAdapter("protractor")!.mapServiceJob(1,"ro",incomplete.ServicePackages[0]);
assert.equal(incompleteJob.laborHoursBilled,2,"legacy adapter can contain only a partial sum");
const incompleteOrder=getAdapter("protractor")!.mapWorkOrder(1,incomplete);
assert.equal(incompleteOrder.customFields?.laborReporting?.sold,null,"explicit unknown must survive SQL selection");
assert.doesNotMatch(LABOR_REPORT_SQL,/THEN t\.(sold|presented)/,"incomplete legacy sums cannot become covered evidence");
assert.equal(protractorInvoiceLaborEvidence({...raw,WorkflowStage:"Appointment"}),null);
assert.match(LABOR_REPORT_SQL,/status IN \('closed','invoiced','paid'\)/);
assert.match(LABOR_REPORT_SQL,/coalesce\(wo.closed_date,wo.completed_date\)::date business_date/);
assert.match(LABOR_REPORT_SQL,/DISTINCT ON \(shop_id, work_order_id, package_key\)/);
assert.match(LABOR_REPORT_SQL,/j\.shop_id=o\.shop_id AND j\.work_order_id=o\.id/);
async function pipeline() {
  const scope = {kind:"enterprise" as const,shopIds:[1],shops:[{shopId:1,name:"One",locationIdentifier:null}]};
  let calls = 0;
  const result = await getReportingKpis(scope,normalizeReportingRange("2026-01-01","2026-10-05"),{
    executionPlan:compileReportDefinition(def,scope).execution,
    query: async (_sql, params) => { calls++; assert.equal(params[0],"{1}"); return String(params[1]).startsWith("2026-01") ? rows : []; },
  });
  assert.equal(calls,10);
  assert.equal(result.summary.laborClosedROCount,6);
  assert.equal(result.bySoldLaborHours?.length,5);
  assert.equal(result.byLocation[0].metrics.soldLaborCoveredROs,5);
  assert.ok(result.dataQuality.notes.some(n=>n.includes("not reconciled")));
  const partitions = laborPartitions([1,2], new Date("2024-02-01T00:00:00Z"), new Date("2024-03-05T23:59:59.999Z"));
  assert.equal(partitions.length,4);
  assert.equal(partitions[0][2],"2024-02-29T23:59:59.999Z");
  assert.equal(partitions[1][1],"2024-03-01T00:00:00.000Z");
  let failedCalls = 0;
  await assert.rejects(getReportingKpis(scope,normalizeReportingRange("2026-01-01","2026-10-05"),{
    executionPlan:compileReportDefinition(def,scope).execution,
    query: async () => { if (++failedCalls === 2) throw new Error("statement timeout"); return rows; },
  }), /too long/);
  assert.equal(failedCalls,2, "do not return a partial report after a partition failure");
}
pipeline().then(()=>console.log("labor reporting smoke: ALL PASS")).catch(e=>{console.error(e);process.exit(1);});
