/**
 * Read-only, bounded preview. No provider calls, updates, migrations, or credentials
 * in output. Explicit shop IDs (max ten) and one archived day/page are required.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MongoClient } from "../lib/invoice-repair/mongo-client";
import postgres from "../lib/invoice-repair/postgres-client";
import { invoiceHoursEvidence } from "../lib/invoice-hours-contract";

let stage = "arguments";
async function main() {
  const [shopsArg, day] = process.argv.slice(2);
  const shops = [...new Set((shopsArg??"").split(",").map(Number))];
  assert.ok(shops.length<=10 && shops.every(n=>Number.isSafeInteger(n)&&n>0));
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(day??"") && new Date(day).toISOString().slice(0,10)===day);
  assert.ok(process.env.SUPABASE_PROD_DATABASE_URL && process.env.MONGODB_USERNAME && process.env.MONGODB_PASSWORD);
  const mongo = new MongoClient(`mongodb+srv://${encodeURIComponent(process.env.MONGODB_USERNAME!)}:${encodeURIComponent(process.env.MONGODB_PASSWORD!)}@mos-maintenance-mvp.tiixipi.mongodb.net/`,
    {serverSelectionTimeoutMS:10000});
  const pg = postgres(process.env.SUPABASE_PROD_DATABASE_URL!,{max:1,connect_timeout:10});
  try {
    stage = "mongo_connect";
    await mongo.connect();
    const db = mongo.db("mos-maintenance-mvp");
    for (const shopId of shops) {
      stage = "archive_read";
      const page = await db.collection<any>("operator_history_import_pages").findOne({
        _id:`protractor-weekend-2026-10-17:${shopId}:${day}:0`,
      },{maxTimeMS:5000});
      const counts = {shopId,day,archived:0,usableSource:0,candidates:0,alreadyPresent:0,review:0,missingStored:0};
      if (!page) {console.log(JSON.stringify({...counts,missingArchive:true}));continue;}
      assert.equal(page.shopId,shopId);assert.equal(page.day,day);
      assert.ok(Array.isArray(page.invoices)&&page.invoices.length<=100);
      assert.equal(createHash("sha256").update(JSON.stringify(page.invoices)).digest("hex"),page.digest);
      counts.archived=page.invoices.length;
      for (const raw of page.invoices) {
        const evidence=invoiceHoursEvidence(raw);
        if(!evidence)continue;
        counts.usableSource++;
        stage = "mongo_identity_lookup";
        const docs=await db.collection("normalized_work_orders").find({
          shopId,"provenance.sourceSystem":"protractor",
          "provenance.sourceIds.idValue":{$in:[raw.ID,raw.ID.toLowerCase(),raw.ID.toUpperCase()]},
          "provenance.sourceIds":{$elemMatch:{system:"protractor",idValue:{$in:[raw.ID,raw.ID.toLowerCase(),raw.ID.toUpperCase()]}}},
        },{projection:{_id:1,customFields:1,rawPayload:1},maxTimeMS:5000}).limit(2).toArray();
        if(docs.length!==1){counts.missingStored++;continue;}
        const doc=docs[0];
        stage = "postgres_identity_lookup";
        const rows=await pg.begin("read only",async s=>{
          await s.unsafe("SET LOCAL statement_timeout='5s'");
          return s.unsafe("SELECT custom_fields,provenance,raw_data FROM normalized_work_orders WHERE shop_id=$1 AND id=$2 LIMIT 1",
            [shopId,String(doc._id)]);
        });
        if(rows.length!==1){counts.missingStored++;continue;}
        if(!rows[0].provenance?.sourceIds?.some((s:any)=>s.system==="protractor" &&
          ["invoice_id","work_order_id"].includes(s.idType) && String(s.idValue).toLowerCase()===evidence.id)) {
          counts.review++;continue;
        }
        const old=[doc.customFields?.invoiceHours,rows[0].custom_fields?.invoiceHours].filter(Boolean);
        const rawCopies=[doc.rawPayload,rows[0].raw_data?.rawPayload].filter(Boolean);
        const conflictingRaw=rawCopies.some(r=>{
          if(String(r.ID??"").toLowerCase()!==evidence.id)return true;
          const derived=invoiceHoursEvidence(r);
          if(derived && ["sold","presented"].some(k=>{
            const a=derived[k as "sold"|"presented"],b=evidence[k as "sold"|"presented"];
            return a!==null&&b!==null&&a!==b;
          }))return true;
          const date=typeof r.InvoiceTime==="string"
            ? Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(r.InvoiceTime)?r.InvoiceTime:r.InvoiceTime+"Z"):NaN;
          return Number.isFinite(date)&&date!==Date.parse(evidence.date);
        });
        // Existing evidence is never replaced automatically, even if only one
        // store has it. This preview does not certify a full historical repair.
        if(old.length || conflictingRaw) {
          if(old.length===2 && old.every(e=>JSON.stringify(e)===JSON.stringify(evidence))&&!conflictingRaw)counts.alreadyPresent++;
          else counts.review++;
        } else counts.candidates++;
      }
      console.log(JSON.stringify(counts));
    }
  } finally {await mongo.close();await pg.end({timeout:2});}
}
main().catch((error)=>{
  const rawCode = String(error?.code ?? "");
  const code = /^[A-Z0-9]{1,5}$/.test(rawCode) ? rawCode : "UNCLASSIFIED";
  const location = String(error?.stack??"").split("\n")
    .find(line=>line.includes("preview-invoice-evidence-repair.ts:"))?.match(/preview-invoice-evidence-repair\.ts:\d+:\d+/)?.[0];
  console.error(JSON.stringify({event:"evidence_preview_failed",stage,code,location,noRepairsApplied:true}));
  process.exitCode=1;
});
