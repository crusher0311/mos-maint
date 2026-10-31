// Bounded read-only mapping evidence; never reads identities or session tokens.
process.env.SLOW_QUERY_TRACKING_DISABLED = "true";
export {};
async function main() {
  const { getDb } = await import("../lib/mongo");
  const db = await getDb();
  const shops = await db.collection("shops").find({
    $or: [
      { shopId: { $in: [63, "63"] } },
      { "tekmetric.shopId": { $in: [14245, "14245"] } },
      { tekmetricShopId: { $in: [14245, "14245"] } },
    ],
  }, { projection: { _id: 0, shopId: 1, "tekmetric.shopId": 1, tekmetricShopId: 1, integrationProvider: 1 } })
    .maxTimeMS(5000).limit(5).toArray();
  console.log(JSON.stringify({ shops }));
}
main().then(() => process.exit(0)).catch(() => {
  console.error("Bounded read-only mapping inspection unavailable");
  process.exit(1);
});
