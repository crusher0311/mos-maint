import { getDb } from "../lib/mongo";
async function main() {
  const db = await getDb();
  const coll = db.collection("normalized_work_orders");

  // Sample a closed Protractor WO missing dates (PG mirrors Mongo).
  const doc = await coll.findOne(
    {
      "provenance.sourceSystem": "protractor",
      status: "closed",
      closedDate: null,
      completedDate: null,
      shopId: 143,
    },
    { projection: { workOrderNumber: 1, rawPayload: 1, "provenance.rawPayload": 1, shopId: 1 } }
  );
  if (!doc) { console.log("no matching Mongo doc for shop 143"); }
  else {
    const raw = doc.rawPayload ?? doc.provenance?.rawPayload ?? null;
    console.log("sample WO", doc.workOrderNumber, "hasRawPayload:", !!raw);
    if (raw) {
      const keys = Object.keys(raw);
      console.log("raw keys:", keys.slice(0, 40).join(","));
      for (const k of ["InvoiceTime", "InvoiceDate", "Header", "WorkOrderNumber", "InvoiceNumber", "LastModifiedTime", "CreationTime", "Deleted"]) {
        const v = raw[k];
        console.log(` raw.${k}:`, typeof v === "object" && v ? JSON.stringify(v).slice(0, 200) : v);
      }
    }
  }

  // Fleet-wide count in Mongo for comparison
  const n = await coll.countDocuments({
    "provenance.sourceSystem": "protractor",
    status: "closed",
    $and: [{ $or: [{ closedDate: null }, { closedDate: { $exists: false } }] },
           { $or: [{ completedDate: null }, { completedDate: { $exists: false } }] }],
  });
  console.log("\nMongo closed protractor WOs missing dates:", n);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
