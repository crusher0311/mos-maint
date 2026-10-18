import assert from "node:assert/strict";
import postgres from "postgres";
import { userInfo } from "node:os";
import { spawnSync } from "node:child_process";
const port=Number(process.argv[2]);
const pg=postgres({host:"127.0.0.1",port,database:"postgres",username:userInfo().username,max:1});
async function main() {
  await pg`CREATE DATABASE invoice_preview_source`;
  const source=postgres({host:"127.0.0.1",port,database:"invoice_preview_source",username:userInfo().username,max:1});
  try {
    await source`CREATE TABLE normalized_work_orders (id text,shop_id int,status text,soft_delete jsonb,
      provenance jsonb,custom_fields jsonb,raw_data jsonb)`;
    for(let shop=227;shop<=236;shop++) {
      const id=`10000000-0000-0000-0000-000000000${shop}`;
      const raw={ID:id,Type:"Invoice",WorkflowStage:"Invoice",InvoiceNumber:shop,
        InvoiceTime:"2026-10-16T12:00:00Z",ServicePackages:[{
          ID:"job",Status:"Completed",IsInvoicing:true,BilledHours:2,
          ServicePackageLines:[{ID:"line",Type:"Labor",BilledHours:2}],
        }]};
      await source`INSERT INTO normalized_work_orders VALUES (${String(shop)},${shop},'invoiced',null,
        ${source.json({sourceSystem:"protractor",sourceIds:[{system:"protractor",idType:"invoice_id",idValue:id}]})},
        null,${source.json({rawPayload:raw})})`;
    }
    // A real JSON null, not a SQL NULL: must stay unresolved, not crash jsonb_each.
    await source`INSERT INTO normalized_work_orders VALUES ('null-payload',227,'closed',null,
      '{"sourceSystem":"protractor","sourceIds":[]}',null,'{"rawPayload":null}')`;
    const openId="10000000-0000-0000-0000-000000000555";
    await source`INSERT INTO normalized_work_orders VALUES ('stored-open',227,'closed',null,
      ${source.json({sourceSystem:"protractor",sourceIds:[{system:"protractor",idType:"work_order_id",idValue:openId}]})},
      null,${source.json({rawPayload:{ID:openId,Type:"WorkOrder",WorkflowStage:"OnHold",InvoiceNumber:0}})})`;
    for(const n of [333,334]) {
      const id=`10000000-0000-0000-0000-000000000${n}`;
      const raw={ID:id,Type:"Invoice",WorkflowStage:"Invoice",InvoiceNumber:0,
        InvoiceTime:"2026-10-16T12:00:00Z",ServicePackages:[{
          ID:"job",Status:"Completed",IsInvoicing:true,BilledHours:n===333?2:3,
          ServicePackageLines:[{ID:"line",Type:"Labor",BilledHours:n===333?2:3}],
        }]};
      await source`INSERT INTO normalized_work_orders VALUES (${String(n)},227,'closed',null,
        ${source.json({sourceSystem:"protractor",sourceIds:[{system:"protractor",idType:"invoice_id",idValue:id}]})},
        null,${source.json({rawPayload:raw})})`;
    }
    const env:NodeJS.ProcessEnv={NODE_ENV:"test"};
    const creditId="10000000-0000-0000-0000-000000000666";
    await source`INSERT INTO normalized_work_orders VALUES ('credit-only',227,'closed',null,
      ${source.json({sourceSystem:"protractor",sourceIds:[{system:"protractor",idType:"invoice_id",idValue:creditId}]})},
      null,${source.json({rawPayload:{ID:creditId,Type:"CreditSlip",WorkflowStage:"Invoice",InvoiceNumber:666,InvoiceTime:"2026-10-16T12:00:00Z"}})})`;
    for(const suffix of [777,778])for(const copy of [0,1]) {
      const sharedId=`10000000-0000-0000-0000-000000000${suffix}`;
      const raw=copy===1&&suffix===777?null:{
        ID:sharedId,Type:"CreditSlip",WorkflowStage:"Invoice",InvoiceNumber:suffix,
        InvoiceTime:copy===1?"2026-09-01T12:00:00Z":"2026-10-16T12:00:00Z",
      };
      await source`INSERT INTO normalized_work_orders VALUES (${`credit-peer-${suffix}-${copy}`},227,'closed',null,
        ${source.json({sourceSystem:"protractor",sourceIds:[{system:"protractor",idType:"invoice_id",idValue:sharedId}]})},
        null,${source.json({rawPayload:raw})})`;
    }
    for(const key of ["PATH","HOME","USER","LANG","LD_AUDIT","LD_LIBRARY_PATH","REPLIT_LD_LIBRARY_PATH","NIX_LD_LIBRARY_PATH"])
      if(process.env[key])env[key]=process.env[key];
    env.SUPABASE_PROD_DATABASE_URL=`postgres://${userInfo().username}@127.0.0.1:${port}/invoice_preview_source`;
    for(const suffix of [888,889,890])for(const copy of suffix===890?[0,1]:[0]) {
      const identity=`10000000-0000-0000-0000-000000000${suffix}`;
      const raw={ID:identity,Type:"WorkOrder",WorkflowStage:"Invoice",InvoiceNumber:0,
        InvoiceTime:suffix===889||copy===1?"2026-10-16T12:00:00Z":"2026-08-01T12:00:00Z"};
      await source`INSERT INTO normalized_work_orders VALUES (${`date-review-${suffix}-${copy}`},227,'closed',null,
        ${source.json({sourceSystem:"protractor",sourceIds:[{system:"protractor",idType:"invoice_id",idValue:identity}]})},
        null,${source.json({rawPayload:raw})})`;
    }
    env.MONGODB_USERNAME="offline";env.MONGODB_PASSWORD="offline";
    env.PROTRACTOR_OFFLINE_ALLOW_LOOPBACK="true";
    env.NODE_OPTIONS="--require ./tests/helpers/deny-network-egress.cjs --require ./tests/helpers/invoice-preview-mongo.cjs --require ./scripts/_stubs/server-only-stub.cjs";
    const child=spawnSync(process.execPath,["--import","tsx","scripts/validate-jwt-report-local.ts",String(port),"--stored-reconcile","--classify-uninvoiced","--separate-credits","--review-date-scope","--review-chronology","--review-held-sentinels"],{env,encoding:"utf8",timeout:90000});
    assert.equal(child.status,0,child.stdout+"\n"+child.stderr);
    const events=child.stdout.split("\n").filter(x=>x.startsWith("{")).map(x=>JSON.parse(x));
    const after=events.find(e=>e.event==="local_report"&&e.label==="after");
    assert.equal(after.summary.invoiceCount,11);
    assert.equal(after.summary.invoicePopulationUnknown,9);
    const classified=events.find(e=>e.event==="local_report"&&e.label==="after_stored_status_classification");
    assert.equal(classified.summary.invoicePopulationUnknown,8);
    const credits=events.find(e=>e.event==="local_report"&&e.label==="after_separate_credits");
    assert.equal(credits.summary.invoicePopulationUnknown,7,
      "unknown peer and cross-boundary conflicting credit dates must not disappear");
    assert.deepEqual(events.find(e=>e.event==="separate_credit_documents").groups,
      [{period:"report_period",records:1}]);
    assert.equal(credits.summary.invoiceCount,11);
    assert.equal(credits.summary.invoiceSoldHours,22);
    assert.equal(credits.summary.invoicePresentedHours,22);
    assert.equal(credits.summary.averagePresentedHoursPerInvoice,null);
    const dated=events.find(e=>e.event==="local_report"&&e.label==="after_date_scope_experiment");
    assert.equal(dated.summary.invoicePopulationUnknown,6,"Only agreed outside-period dates are removed; in-period and cross-date peers remain");
    assert.equal(dated.summary.invoiceCount,11);
    assert.equal(dated.summary.invoiceSoldHours,22);
    assert.equal(dated.summary.invoicePresentedHours,22);
    assert.equal(dated.summary.averagePresentedHoursPerInvoice,null);
    assert.equal(classified.summary.invoiceCount,11);
    assert.equal(classified.summary.invoiceSoldHours,22);
    assert.equal(classified.summary.averagePresentedHoursPerInvoice,null);
    assert.equal((await source`SELECT status FROM normalized_work_orders WHERE id='stored-open'`)[0].status,"closed");
    assert.equal(after.summary.invoiceSoldHours,22);
    assert.equal(after.summary.invoicePresentedHours,22);
    assert.equal(after.summary.averagePresentedHoursPerInvoice,null,"unknown source population still withholds the full average");
    assert.equal((await source`SELECT count(*)::int n FROM normalized_work_orders WHERE custom_fields IS NOT NULL`)[0].n,0);
    assert.equal(events.find(e=>e.event==="validation_complete").productionWrites,0);
    const counts=events.find(e=>e.event==="shop_snapshot"&&e.shop===227);
    assert.equal(counts.proposed,2,"stored final source and matching archived source recover independently");
    assert.equal(counts.conflict,1,"conflicting hours remain unresolved even when legacy invoice number is missing");
    // Re-running a retained local database must use completed shop checkpoints
    // and restore the original baseline, not treat prior local repairs as source.
    const chrono=events.find(e=>e.event==="local_report"&&e.label==="after_chronology_experiment");
    assert.deepEqual(chrono.summary,dated.summary,"Fixtures without qualifying older snapshots must not change");
    const resumed=spawnSync(process.execPath,["--import","tsx","scripts/validate-jwt-report-local.ts",String(port),"--stored-reconcile","--classify-uninvoiced","--separate-credits","--review-date-scope","--review-chronology","--review-held-sentinels"],{env,encoding:"utf8",timeout:90000});
    assert.equal(resumed.status,0,resumed.stdout+"\n"+resumed.stderr);
    const resumedEvents=resumed.stdout.split("\n").filter(x=>x.startsWith("{")).map(x=>JSON.parse(x));
    assert.equal(resumedEvents.filter(e=>e.event==="shop_copy_resumed").length,10);
    assert.equal(resumedEvents.filter(e=>e.event==="shop_copy_started").length,0);
    assert.deepEqual(resumedEvents.find(e=>e.event==="local_report"&&e.label==="before"),
      events.find(e=>e.event==="local_report"&&e.label==="before"));
    assert.deepEqual(resumedEvents.find(e=>e.event==="local_report"&&e.label==="after"),after);
    assert.deepEqual(resumedEvents.find(e=>e.event==="local_report"&&e.label==="after_stored_status_classification"),classified);
    assert.deepEqual(resumedEvents.find(e=>e.event==="local_report"&&e.label==="after_separate_credits"),credits);
    assert.deepEqual(resumedEvents.find(e=>e.event==="local_report"&&e.label==="after_date_scope_experiment"),dated);
    assert.deepEqual(resumedEvents.find(e=>e.event==="local_report"&&e.label==="after_chronology_experiment"),chrono);
    console.log("PASS: read-only source, disposable-only repair, full report SQL, ten locations, null payload and unresolved coverage");
  } finally {await source.end();}
}
main().finally(()=>pg.end()).catch(e=>{console.error(e);process.exitCode=1});
