/** Offline diagnostics only. No production connections or provider clients. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {userInfo} from "node:os";
import postgres from "postgres";
import {INVOICE_HOURS_SQL} from "../lib/invoice-hours-query";
import {aggregateInvoiceHours} from "../lib/invoice-hours-contract";

async function main() {
  const port=Number(process.argv[2]);
  assert.ok(Number.isInteger(port)&&port>1024&&port<65536);
  const db=postgres({host:"127.0.0.1",port,username:userInfo().username,database:"postgres",max:1,
    connection:{statement_timeout:60000}});
  const start="2026-09-18T00:00:00.000Z",end="2026-10-17T23:59:59.999Z";
  try {
    assert.equal((await db`SELECT current_setting('invoice_preview.disposable',true) marker`)[0].marker,"yes");
    // Reuse the exact reviewed experiment SQL; only TEMP objects are created.
    const source=readFileSync("scripts/validate-jwt-report-local.ts","utf8");
    for(const name of ["credit_exclusions","date_exclusions"]) {
      const text=source.match(new RegExp("CREATE TEMP TABLE "+name+" AS[\\s\\S]*?(?=`;)"))?.[0];
      assert.ok(text);
      await db.unsafe(text.replaceAll("${start}","$1").replaceAll("${end}","$2"),name==="date_exclusions"?[start,end]:[]);
      await db.unsafe(`CREATE UNIQUE INDEX ON ${name}(id)`);
      await db.unsafe(`ANALYZE ${name}`);
    }
    await db`CREATE TEMP VIEW remainder_preview AS SELECT w.* FROM normalized_work_orders w
      WHERE NOT EXISTS(SELECT 1 FROM credit_exclusions c WHERE c.id=w.id)
      AND NOT EXISTS(SELECT 1 FROM date_exclusions d WHERE d.id=w.id)`;
    const facts=await db.unsafe(INVOICE_HOURS_SQL.replaceAll("normalized_work_orders","remainder_preview"),
      ["{227,228,229,230,231,232,233,234,235,236}",start,end]);
    const summary=aggregateInvoiceHours(facts as any,new Date(start),new Date(end)).summary;
    assert.equal(summary.invoicePopulationUnknown,152,"Retained result must reproduce exactly");
    assert.equal(summary.invoiceCount,6259);
    console.log(JSON.stringify({event:"reproduced",summary}));
    const rows=await db`SELECT d.reason,r.classification date_review,r.date,u.classification status_review,
      u.shape,w.shop_id,w.status,count(*)::int records
      FROM normalized_work_orders w JOIN evidence_diagnostics d ON d.id=w.id
      LEFT JOIN date_reviews r ON r.id=w.id LEFT JOIN uninvoiced_review u ON u.id=w.id
      WHERE w.id=ANY(${db.array(facts.map(f=>f.id))})
      AND d.reason<>'verified_complete'
      GROUP BY d.reason,r.classification,r.date,u.classification,u.shape,w.shop_id,w.status
      ORDER BY d.reason,w.shop_id`;
    console.log(JSON.stringify({event:"remaining_diagnostics",rows}));
    const reviewFile=process.argv[3];
    if(reviewFile) {
      const events=readFileSync(reviewFile,"utf8").trim().split("\n").map(l=>JSON.parse(l));
      assert.equal(events.at(-1)?.event,"targeted_trace_complete");
      const records=events.filter(e=>e.event==="targeted_trace_record");
      assert.equal(records.length,48);
      assert.equal(new Set(records.map(r=>r.record)).size,48);
      await db`CREATE TEMP TABLE date_reviews AS SELECT * FROM public.date_reviews`;
      let eligible=0;
      for(const r of records) {
        if(r.chronology?.classification!=="consistent_final_invoice_date")continue;
        const changed=await db`UPDATE date_reviews r SET classification='consistent_final_invoice_date',date=${r.chronology.date}
          FROM evidence_diagnostics d WHERE r.id=${r.record} AND r.shop_id=${r.shop}
          AND d.id=r.id AND d.reason='missing_positive_invoice_number'
          AND r.classification='finality_unverified' RETURNING r.id`;
        assert.equal(changed.length,1);
        eligible++;
      }
      await db`DROP TABLE date_exclusions CASCADE`;
      const text=source.match(/CREATE TEMP TABLE date_exclusions AS[\s\S]*?(?=`;)/)?.[0];
      assert.ok(text);
      await db.unsafe(text.replaceAll("${start}","$1").replaceAll("${end}","$2"),[start,end]);
      await db`CREATE UNIQUE INDEX ON date_exclusions(id)`;
      await db`ANALYZE date_exclusions`;
      await db`CREATE TEMP VIEW remainder_preview AS SELECT w.* FROM normalized_work_orders w
        WHERE NOT EXISTS(SELECT 1 FROM credit_exclusions c WHERE c.id=w.id)
        AND NOT EXISTS(SELECT 1 FROM date_exclusions d WHERE d.id=w.id)`;
      const after=await db.unsafe(INVOICE_HOURS_SQL.replaceAll("normalized_work_orders","remainder_preview"),
        ["{227,228,229,230,231,232,233,234,235,236}",start,end]);
      const result=aggregateInvoiceHours(after as any,new Date(start),new Date(end)).summary;
      assert.equal(result.invoiceCount,summary.invoiceCount);
      assert.equal(result.invoiceSoldCovered,summary.invoiceSoldCovered);
      assert.equal(result.invoicePresentedCovered,summary.invoicePresentedCovered);
      assert.ok(result.invoiceSoldHours!=null&&summary.invoiceSoldHours!=null);
      assert.ok(result.invoicePresentedHours!=null&&summary.invoicePresentedHours!=null);
      assert.ok(result.invoicePopulationUnknown!=null);
      assert.ok(Math.abs(result.invoiceSoldHours-summary.invoiceSoldHours)<1e-6);
      assert.ok(Math.abs(result.invoicePresentedHours-summary.invoicePresentedHours)<1e-6);
      assert.ok(result.invoicePopulationUnknown<=152&&result.invoicePopulationUnknown>=152-eligible);
      console.log(JSON.stringify({event:"chronology_report",eligible,summary:result,productionWrites:0,providerRequests:0}));
    }
  } finally {await db.end();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
