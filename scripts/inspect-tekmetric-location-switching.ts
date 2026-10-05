// Read-only, narrow, redacted diagnosis. No user identities or credentials printed.
process.env.SLOW_QUERY_TRACKING_DISABLED = "true";
export {};
async function main() {
  const { getDb } = await import("../lib/mongo");
  const db = await getDb();
  const shops = await db.collection("shops").find({
    $or: [{ name: /burlington|vpx/i }, { shopName: /burlington|vpx/i }, { "tekmetric.shopName": /burlington|vpx/i }],
  }, { projection: { _id: 0, shopId: 1, name: 1, shopName: 1, enterpriseId: 1, "tekmetric.shopId": 1, tekmetricShopId: 1 } })
    .maxTimeMS(5000).limit(10).toArray();
  for (const shop of shops) {
    const id = shop.tekmetric?.shopId ?? shop.tekmetricShopId;
    const mappings = id == null ? [] : await db.collection("shops").find({
      $or: [{ "tekmetric.shopId": { $in: [String(id), Number(id)] } }, { tekmetricShopId: { $in: [String(id), Number(id)] } }],
    }, { projection: { _id: 0, shopId: 1 } }).maxTimeMS(5000).limit(5).toArray();
    console.log(JSON.stringify({ ...shop, canonicalOwners: mappings.map(s => s.shopId) }));
  }
  console.log("Affected advisor not identified; no account lookup performed. Browser-installed version not observable here.");
  const recent = await db.collection("extension_telemetry_events").find({
    mosShopId: { $in: [265, 266, 519] },
  }, { projection: { _id: 0, mosShopId: 1, extensionVersion: 1, occurredAt: 1 } })
    .sort({ _id: -1 }).maxTimeMS(5000).limit(5).toArray();
  console.log("Recent shop telemetry (not proof of the affected browser's version):", JSON.stringify(recent));
}
main().then(() => process.exit(0)).catch(e => { console.error(e.name, "Read-only inspection unavailable"); process.exit(1); });
