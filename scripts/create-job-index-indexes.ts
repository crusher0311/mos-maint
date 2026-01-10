import { getDb } from "../lib/mongo";

async function createIndexes() {
  console.log("[Indexes] Connecting to MongoDB...");
  const db = await getDb();
  const collection = db.collection("job_index");

  console.log("[Indexes] Creating indexes on job_index collection...");

  const indexes = [
    { keys: { shopId: 1, "job.keywords": 1 }, name: "shopId_keywords" },
    { keys: { shopId: 1, performedAt: -1 }, name: "shopId_performedAt" },
    { keys: { shopId: 1, "vehicle.make": 1, "vehicle.model": 1 }, name: "shopId_make_model" },
    { keys: { shopId: 1, "job.title": 1 }, name: "shopId_title" },
    { keys: { "job.keywords": 1 }, name: "keywords" },
    { keys: { contentHash: 1 }, name: "contentHash" },
  ];

  for (const idx of indexes) {
    try {
      await collection.createIndex(idx.keys, { name: idx.name, background: true });
      console.log(`[Indexes] Created index: ${idx.name}`);
    } catch (err: any) {
      if (err.code === 85 || err.code === 86) {
        console.log(`[Indexes] Index ${idx.name} already exists (skipping)`);
      } else {
        console.error(`[Indexes] Failed to create ${idx.name}:`, err.message);
      }
    }
  }

  console.log("[Indexes] Creating text index for full-text search...");
  try {
    await collection.createIndex(
      { "job.title": "text", "job.keywords": "text" },
      { name: "job_text_search", background: true }
    );
    console.log("[Indexes] Created text index: job_text_search");
  } catch (err: any) {
    if (err.code === 85 || err.code === 86) {
      console.log("[Indexes] Text index already exists (skipping)");
    } else {
      console.error("[Indexes] Failed to create text index:", err.message);
    }
  }

  console.log("[Indexes] Listing all indexes on job_index:");
  const allIndexes = await collection.indexes();
  for (const idx of allIndexes) {
    console.log(`  - ${idx.name}: ${JSON.stringify(idx.key)}`);
  }

  console.log("[Indexes] Done!");
  process.exit(0);
}

createIndexes().catch((err) => {
  console.error("[Indexes] Fatal error:", err);
  process.exit(1);
});
