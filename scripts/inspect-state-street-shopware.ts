/**
 * Read-only incident inventory. No app boot, telemetry, indexes or writes.
 * Run: npx tsx scripts/inspect-state-street-shopware.ts --production-provider-read
 * Output deliberately excludes credentials, contacts, and provider payloads.
 */
import { MongoClient } from "mongodb";

async function main() {
  if (process.argv.slice(2).some(arg => arg !== "--production-provider-read")) {
    throw new Error("This inventory accepts no mutation flags");
  }
  const uri = process.env.MONGODB_URI && !process.env.MONGODB_URI.includes("localhost")
    ? process.env.MONGODB_URI
    : process.env.MONGODB_USERNAME && process.env.MONGODB_PASSWORD
      ? `mongodb+srv://${encodeURIComponent(process.env.MONGODB_USERNAME)}:${encodeURIComponent(process.env.MONGODB_PASSWORD)}@mos-maintenance-mvp.tiixipi.mongodb.net/mos-maintenance-mvp?retryWrites=false`
      : null;
  if (!uri) throw new Error("Mongo credentials unavailable");
  const client = new MongoClient(uri, {
    maxPoolSize: 1, serverSelectionTimeoutMS: 10000, socketTimeoutMS: 15000,
    retryWrites: false, retryReads: false,
  });
  try {
    await client.connect();
    const db = client.db("mos-maintenance-mvp");
    const shops = await db.collection("shops").find({
      $or: [
        { shopId: { $in: [136, "136"] } },
        { "shopware.tenantSubdomain": "allcare-services-llc" },
        { "shopware.tenantId": { $in: ["allcare-services-llc", 5700, "5700"] } },
        { "shopware.swShopId": { $in: [6194, "6194"] } },
      ],
    }, { projection: {
      _id: 1, shopId: 1, name: 1, integrationProvider: 1,
      "shopware.tenantId": 1, "shopware.tenantSubdomain": 1,
      "shopware.swShopId": 1, "shopware.shopName": 1,
    }, maxTimeMS: 5000 }).limit(51).toArray();
    if (shops.length > 50) throw new Error("Inventory cap exceeded; no ownership conclusion");
    console.log(JSON.stringify({ observedAt: new Date().toISOString(), database: db.databaseName, shops }, null, 2));

    if (!process.argv.includes("--production-provider-read") && (process.env.SHOPWARE_USE_SANDBOX === "true" ||
        (process.env.SHOPWARE_API_BASE_URL && process.env.SHOPWARE_API_BASE_URL !== "https://api.shop-ware.com/api/v1"))) {
      throw new Error("Explicit production read required");
    }
    const partner = process.env.SHOPWARE_PARTNER_API_ID;
    const secret = process.env.SHOPWARE_API_SECRET;
    if (!partner || !secret) throw new Error("Shop-Ware credentials unavailable");
    // Direct GETs avoid the normal client's write-producing usage telemetry.
    const tenants = [...new Set([5700, ...shops.map(s => Number(s.shopware?.tenantId)).filter(Number.isSafeInteger)])];
    if (tenants.length > 10) throw new Error("Tenant evidence cap exceeded");
    for (const tenant of tenants) {
      for (const suffix of ["", "/shops?per_page=100&page=1"]) {
        const response = await fetch(`https://api.shop-ware.com/api/v1/tenants/${tenant}${suffix}`, {
          method: "GET", signal: AbortSignal.timeout(15000), redirect: "error",
          headers: { "X-Api-Partner-Id": partner, "X-Api-Secret": secret, Accept: "application/json" },
        });
        if (!response.ok) {
          console.log(JSON.stringify({ tenant, resource: suffix ? "shops" : "tenant", status: response.status }));
          process.exitCode = 1;
          continue;
        }
        const data = await response.json();
        console.log(JSON.stringify(suffix ? {
          tenant, resource: "shops", currentPage: data.current_page, totalPages: data.total_pages,
          shops: data.results?.map((s: any) => ({ id: s.id, name: s.name, tenant_id: s.tenant_id })),
        } : {
          tenant, resource: "tenant", id: data.id, name: data.name, cname: data.cname,
        }, null, 2));
      }
    }
  } finally {
    await client.close();
  }
}
main().catch(() => {
  // Never print driver/fetch exceptions: they may contain connection details.
  console.error("Read-only inventory incomplete; inspect the last successful stage. No writes performed.");
  process.exitCode = 1;
});
