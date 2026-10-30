/**
 * Explicit operator-run, read-only HEART validation. No upstream APIs or writes.
 * Persist only report output locally; never persist customer/contact payloads.
 */
import { MongoClient } from "mongodb";
import { mkdir, writeFile } from "node:fs/promises";
import { emptyTireResult, extractTireInvoice, tireCoverageGap, tireCsv, validateTireDefinition } from "../lib/tire-dot-report";

async function main() {
  const [start, end] = process.argv.slice(2);
  validateTireDefinition({ dateRange: { start, end }, locationIds: [1] });
  if (process.env.TEKMETRIC_CACHE_PG_CANONICAL === "1") throw new Error("Mongo validation is not valid for PG-canonical mode");
  const client = new MongoClient(`mongodb+srv://${encodeURIComponent(process.env.MONGODB_USERNAME!)}:${encodeURIComponent(process.env.MONGODB_PASSWORD!)}@mos-maintenance-mvp.tiixipi.mongodb.net/`,
    { serverSelectionTimeoutMS: 10000, maxPoolSize: 1 });
  const out = `generated-artifacts/heart-tire-dot-validation/${start}_${end}`;
  await mkdir(out, { recursive: true, mode: 0o700 });
  try {
    await client.connect();
    const db = client.db("mos-maintenance-mvp");
    const enterprise = await db.collection("enterprise_accounts").findOne({ name: "HEART Certified Auto Care" },
      { projection: { name: 1, shopIds: 1 }, maxTimeMS: 3000 });
    if (!enterprise || !Array.isArray(enterprise.shopIds)) throw new Error("HEART membership unavailable");
    const ids = [...new Set<number>(enterprise.shopIds.map(Number))].sort((a,b) => a-b);
    const definition = validateTireDefinition({ dateRange: { start, end }, locationIds: ids });
    const endExclusive = new Date(Date.parse(end) + 86400000).toISOString().slice(0,10);
    const shops = await db.collection("shops").find({ shopId: { $in: ids.flatMap(id => [id, String(id)]) } },
      { projection: { shopId: 1, name: 1, locationIdentifier: 1, integrationProvider: 1, "tekmetric.shopId": 1, tekmetricShopId: 1 }, maxTimeMS: 3000 }).limit(100).toArray();
    if (shops.length !== ids.length) throw new Error("Membership does not resolve to exactly one record per location");
    const result = emptyTireResult(definition, shops.map(s => ({ shopId: Number(s.shopId), name: `${s.name} - ${s.locationIdentifier || s.shopId}` })));
    tireCoverageGap(result, "Validation reads only records matching retained raw or header posted dates. Records missing both dates cannot be assigned to this period; full upstream coverage is unverified.");
    const diagnostics: any[] = [];
    const persist = async () => {
      result.generatedAt = new Date().toISOString();
      await writeFile(`${out}/result.json`, JSON.stringify(result, null, 2), { mode: 0o600 });
      await writeFile(`${out}/invoices.csv`, tireCsv(result, "invoices"), { mode: 0o600 });
      await writeFile(`${out}/details.csv`, tireCsv(result, "details"), { mode: 0o600 });
      await writeFile(`${out}/coverage.json`, JSON.stringify({ enterprise: enterprise.name, range: definition.dateRange, counts: result.counts, coverage: result.coverage, diagnostics }, null, 2), { mode: 0o600 });
    };
    for (const id of ids) {
      const shop = shops.find(s => Number(s.shopId) === id)!;
      if (shop.integrationProvider && shop.integrationProvider !== "tekmetric") throw new Error(`Location ${id} is not Tekmetric`);
      const before = result.coverage.scanned;
      const row: any = { shopId: id, name: shop.locationIdentifier || shop.name, traversed: false, scanned: 0, inPeriodRaw: 0, rawWithDots: 0, rawDotEntries: 0 };
      diagnostics.push(row);
      // Reuse an existing production index. No new index or unbounded cursor.
      const cursor = db.collection("tekmetric_work_orders").aggregate([
        { $match: { shopId: { $in: [id, String(id)] }, $or: [
          { "data.postedDate": { $gte: start, $lt: endExclusive } },
          { "data.postedDate": { $gte: new Date(start), $lt: new Date(endExclusive) } },
          { postedDate: { $gte: start, $lt: endExclusive } },
          { postedDate: { $gte: new Date(start), $lt: new Date(endExclusive) } },
        ] } },
        { $sort: { workOrderId: -1 } },
        { $limit: 20001 },
        { $project: { shopId: 1, workOrderId: 1, status: 1, repairOrderStatus: 1, deletedDate: 1, deletedAt: 1,
          deleted: 1, isDeleted: 1, archived: 1, isArchived: 1, archivedDate: 1,
          oversized: { $gt: [{ $bsonSize: "$$ROOT" }, 1000000] },
          data: { $cond: [{ $lte: [{ $bsonSize: "$$ROOT" }, 1000000] }, "$data", null] } } },
      ], { hint: "shopId_workOrderId", maxTimeMS: 10000, batchSize: 1 });
      try {
        for await (const doc of cursor) {
          if (row.scanned >= 20000 || result.coverage.scanned >= 100000 || result.limited) {
            result.limited = true; tireCoverageGap(result, "Validation scan or result limit reached; remaining source records are not covered."); break;
          }
          const raw = doc.data;
          const day = typeof raw?.postedDate === "string" ? raw.postedDate.slice(0,10) : "";
          if (day >= start && day <= end) {
            row.inPeriodRaw++;
            if (raw.jobs?.some((j: any) => j.parts?.some((p: any) => Array.isArray(p.dotNumbers) && p.dotNumbers.length))) row.rawWithDots++;
            row.rawDotEntries += (raw.jobs || []).reduce((sum:number,j:any)=>sum+(j.parts||[]).reduce((n:number,p:any)=>n+(Array.isArray(p.dotNumbers)?p.dotNumbers.length:0),0),0);
          }
          extractTireInvoice(result, id, doc);
          row.scanned = result.coverage.scanned - before;
        }
        row.traversed = !result.limited;
      } catch (e: any) {
        row.errorCode = e.code || e.name;
        tireCoverageGap(result, `Location ${id} traversal failed or timed out; coverage is incomplete.`);
      } finally { await cursor.close(); }
      await persist();
      console.log(JSON.stringify({ ...row, counts: result.counts }));
      if (result.limited) break;
    }
    console.log(JSON.stringify({ savedTo: out, counts: result.counts, coverage: result.coverage, diagnostics }));
  } finally { await client.close(); }
}
main().catch(e => { console.error(e instanceof Error ? e.message.replace(/mongodb\S+/g, "[redacted]") : "Validation failed"); process.exitCode = 1; });
