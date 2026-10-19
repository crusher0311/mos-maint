import assert from "node:assert/strict";
import postgres from "postgres";
import { userInfo } from "node:os";
import { admitInvoiceStream, streamInvoiceFleet, INVOICE_STREAM_SELECT } from "../lib/invoice-fleet-stream";
import { aggregateInvoiceHours, combineInvoiceLocationDiagnostics } from "../lib/invoice-hours-contract";

const pg = postgres({ host: process.argv[2], port: 5432, username: userInfo().username,
  database: "postgres", max: 1, onnotice: () => {} });
const start = new Date("2026-09-18T00:00:00Z"), end = new Date("2026-10-17T23:59:59.999Z");
async function main() {
  assert.equal((await pg`SELECT current_setting('invoice_preview.disposable',true) marker`)[0].marker,"yes");
  // Fixture construction/oracle may sort; only the tested reader must not spill.
  await pg`SET temp_file_limit='-1'`;
  await pg`CREATE ROLE report_reader`;
  await pg`GRANT USAGE ON SCHEMA public TO report_reader`;
  await pg`GRANT SELECT ON ALL TABLES IN SCHEMA public TO report_reader`;
  const ids = [227,228,229,230,231,232,233,234,235,236];
  const table = process.argv.includes("--snapshot") ? "fleet_work_orders" : "stream_fixture";
  if (table === "stream_fixture") {
    await pg`CREATE TYPE stream_status AS ENUM ('invoiced','WorkOrderAuthorized','voided','cancelled')`;
    await pg`CREATE TABLE stream_fixture(id text,shop_id int,status stream_status,
      soft_delete jsonb,provenance jsonb,custom_fields jsonb)`;
    await pg`INSERT INTO stream_fixture SELECT shop||':'||n,shop,'invoiced',null,
      jsonb_build_object('sourceSystem','protractor','sourceIds',jsonb_build_array(jsonb_build_object(
        'system','protractor','idType','invoice_id','idValue',md5(shop||':'||n)::uuid::text))),
      jsonb_build_object('invoiceHours',jsonb_build_object('version',1,'id',md5(shop||':'||n)::uuid::text,
        'date','2026-10-01T00:00:00.000Z','sold',2,'presented',3))
      FROM generate_series(227,236) shop CROSS JOIN generate_series(1,12000) n`;
    await pg`CREATE INDEX ON stream_fixture(shop_id)`;
    await pg`GRANT SELECT ON stream_fixture TO report_reader`;
  }
  const replace = (text: string) => text.replaceAll("normalized_work_orders", table);
  const expected = new Map<number, any>();
  // Independent contract oracle; fixture queries are outside the production path.
  for (const shop of ids) {
    const rows = await pg.unsafe(`SELECT id,shop_id,status,provenance->>'sourceSystem' provider,
      provenance->'sourceIds' source_ids,custom_fields->'invoiceHours' invoice_evidence
      FROM ${table} WHERE shop_id=$1 AND NOT coalesce((soft_delete->>'isDeleted')::boolean,false)
      AND status::text NOT IN ('voided','cancelled')`, [shop]);
    expected.set(shop, aggregateInvoiceHours(rows as any,start,end).summary);
  }
  let queries = 0;
  const started = performance.now();
  const actual = await pg.begin(async tx => {
    await tx.unsafe("SET LOCAL temp_file_limit='0'");
    await tx.unsafe("SET LOCAL ROLE report_reader");
    const query = async (text: string, params: unknown[]) => {
      assert.ok(!text.includes("temp_file_limit"),"runtime must never need privileged SET");
      queries++;
      await tx.unsafe("SET LOCAL statement_timeout='5s'");
      return tx.unsafe(replace(text), params as any[]);
    };
    await admitInvoiceStream(query);
    assert.equal((await tx.unsafe("SELECT has_parameter_privilege(current_user,'temp_file_limit','SET') can_set"))[0].can_set,false);
    // Server started with temp_file_limit=0: any real disk spill fails the test.
    assert.equal((await tx.unsafe("SHOW temp_file_limit"))[0].temp_file_limit,"0");
    const plan = await tx.unsafe("EXPLAIN (FORMAT JSON) "+replace(INVOICE_STREAM_SELECT),[ids[0]]);
    assert.doesNotMatch(JSON.stringify(plan), /"Node Type":"(?:Sort|Aggregate|Materialize|Gather|Hash Join)"/);
    return streamInvoiceFleet(query,ids,ids,start,end,Date.now()+45_000);
  });
  assert.deepEqual(actual.summary, combineInvoiceLocationDiagnostics(ids,expected));
  assert.deepEqual(actual.locations,expected);
  console.log(JSON.stringify({test:table,passed:true,elapsedMs:Math.round(performance.now()-started),queries,summary:actual.summary}));
  await assert.rejects(streamInvoiceFleet(async()=>{throw Error("should not query");},ids,[999],start,end,Date.now()+1000),/authorized/);
  await assert.rejects(streamInvoiceFleet(async()=>[],ids,ids,start,end,0),/time budget/);
  // Forced late failure must not return a completed subset.
  let pages = 0;
  await assert.rejects(streamInvoiceFleet(async(sql) => {
    if (sql.startsWith("FETCH")) {
      if (++pages === 2) throw Error("late query failure");
      return [];
    }
    return [];
  },ids,ids,start,end,Date.now()+1000),/late query failure/);
  await assert.rejects(streamInvoiceFleet(async(sql) => sql.startsWith("FETCH") ? [{
    shop_id:227,id:"oversized",evidence_bytes:32769,source_ids:[],invoice_evidence:null,
  }] : [],ids,[227],start,end,Date.now()+1000),/budget/);
  if (table === "stream_fixture") {
    const other = postgres({host:process.argv[2],port:5432,username:userInfo().username,
      database:"postgres",max:1,onnotice:()=>{}});
    try {
      await pg.begin(async tx => {
        await tx.unsafe("SET LOCAL ROLE report_reader");
        const q = (text:string,p:unknown[]) => tx.unsafe(replace(text),p as any[]);
        await admitInvoiceStream(q);
        await assert.rejects(other.begin(async rival => {
          await rival.unsafe("SET LOCAL ROLE report_reader");
          await admitInvoiceStream((text,p)=>rival.unsafe(text,p as any[]));
        }),/Another fleet invoice report/);
        const before = await tx.unsafe("SELECT status FROM stream_fixture WHERE id='227:2'");
        await other`UPDATE stream_fixture SET status='voided' WHERE id='227:2'`;
        const after = await tx.unsafe("SELECT status FROM stream_fixture WHERE id='227:2'");
        assert.deepEqual(after,before,"all locations must use one snapshot despite concurrent ingestion");
      });
      await other`UPDATE stream_fixture SET status='invoiced' WHERE id='227:2'`;
    } finally { await other.end(); }
    // A peer outside the period must veto a previously valid invoice.
    await pg`INSERT INTO stream_fixture SELECT 'conflict',shop_id,status,soft_delete,provenance,
      jsonb_set(custom_fields,'{invoiceHours,date}','"2020-01-01T00:00:00.000Z"')
      FROM stream_fixture WHERE id='227:1'`;
    const conflict = await pg.begin(async tx => {
      await tx.unsafe("SET LOCAL temp_file_limit='0'");
      await tx.unsafe("SET LOCAL ROLE report_reader");
      const q = (text:string,p:unknown[]) => tx.unsafe(replace(text),p as any[]);
      await admitInvoiceStream(q);
      return streamInvoiceFleet(q,ids,[227],start,end,Date.now()+10000);
    });
    assert.equal(conflict.summary.invoicePopulationUnknown,1);
    assert.equal(conflict.summary.averageSoldHoursPerInvoice,null);
  }
  console.log("PASS: restricted role, zero spill, exact location parity, scope, deadline, late failure, byte cap, conflict");
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>pg.end({timeout:2}));
