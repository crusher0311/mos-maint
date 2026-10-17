import assert from "node:assert/strict";
import postgres from "postgres";
import { userInfo } from "node:os";
import { INVOICE_HOURS_SQL, INVOICE_HOURS_INDEX_SQL } from "../lib/invoice-hours-query";
import { aggregateInvoiceHours } from "../lib/invoice-hours-contract";
const pg = postgres({ host: "127.0.0.1", port: Number(process.argv[2]), database: "postgres", username: userInfo().username, max: 1 });
async function main() {
  await pg`CREATE TEMP TABLE normalized_work_orders (id text,shop_id int,status text,soft_delete jsonb,provenance jsonb,custom_fields jsonb)`;
  await pg`INSERT INTO normalized_work_orders
    SELECT n::text,1,'invoiced',null,
      jsonb_build_object('sourceSystem','protractor','sourceIds',jsonb_build_array(jsonb_build_object('system','protractor','idType','invoice_id','idValue',md5(n::text)::uuid::text))),
      jsonb_build_object('invoiceHours',jsonb_build_object('version',1,'id',md5(n::text)::uuid::text,'date',CASE WHEN n<=10 THEN '2026-09-01T00:00:00.000Z' ELSE '2020-01-01T00:00:00.000Z' END,'sold',2,'presented',3))
    FROM generate_series(1,120000) n`;
  await pg`CREATE INDEX ON normalized_work_orders(shop_id, (lower(custom_fields->'invoiceHours'->>'id')))`;
  await pg`ANALYZE normalized_work_orders`;
  for (const sql of INVOICE_HOURS_INDEX_SQL.replaceAll("CONCURRENTLY ", "").split(";").filter(s => s.trim())) await pg.unsafe(sql);
  await pg`SET statement_timeout='10s'`;
  const params = ["{1}", "2026-09-01T00:00:00.000Z", "2026-09-02T23:59:59.999Z"];
  const started = Date.now();
  const rows = await pg.unsafe(INVOICE_HOURS_SQL, params);
  assert.equal(rows.length,10);
  assert.equal(aggregateInvoiceHours(rows as any, new Date(params[1]),new Date(params[2])).summary.averageSoldHoursPerInvoice,2);
  await pg`INSERT INTO normalized_work_orders SELECT 'conflict',shop_id,status,soft_delete,provenance,jsonb_set(custom_fields,'{invoiceHours,date}','"2020-01-01T00:00:00.000Z"') FROM normalized_work_orders WHERE id='1'`;
  await pg`INSERT INTO normalized_work_orders VALUES ('unknown',1,'invoiced',null,'{"sourceSystem":"protractor"}',null)`;
  const uncertain = aggregateInvoiceHours(await pg.unsafe(INVOICE_HOURS_SQL, params) as any,new Date(params[1]),new Date(params[2])).summary;
  assert.equal(uncertain.invoicePopulationUnknown,2);
  assert.equal(uncertain.averageSoldHoursPerInvoice,null);
  const explain = await pg.unsafe(`EXPLAIN (ANALYZE, FORMAT JSON) ${INVOICE_HOURS_SQL}`,params);
  console.log("Bounded invoice fixture: 120,000 historical rows, 10 in range; elapsed ms",Date.now()-started);
  console.log(JSON.stringify(explain));
  assert.ok(JSON.stringify(explain).includes("reporting_invoice_verified_date"), "date index is used");
}
main().finally(() => pg.end()).catch(error => { console.error(error); process.exitCode=1; });
