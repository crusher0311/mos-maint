import { getDb, getMongoClient } from "../lib/mongo";
import { extractProtractorServicePackages, getProtractorPackageLines } from "../lib/integrations/protractor/package-normalization";
async function main() {
  const db = await getDb();
  const rows = await db.collection("protractor_work_orders").find(
    { shopId: 227 }, { projection: { rawPayload: 1, workOrderNumber: 1 }, maxTimeMS: 5000 },
  ).limit(3).toArray();
  for (const row of rows) {
    const raw = row.rawPayload || {};
    const pick = (x: any) => Object.fromEntries(Object.entries(x).filter(([k,v]) =>
      /hour|cost|price|discount|total|status|type|quantity|invoiceTime/i.test(k) &&
      (v === null || typeof v !== "object" || k === "PriceSummary")));
    console.log(JSON.stringify({ ro: row.workOrderNumber, invoice: pick(raw),
      packages: extractProtractorServicePackages(raw).map(p => ({
        ...pick(p), deferred: p._isDeferred,
        lines: getProtractorPackageLines(p).map(pick),
      })) }));
  }
  await (await getMongoClient()).close();
}
main().catch(e => { console.error(e.message); process.exit(1); });
