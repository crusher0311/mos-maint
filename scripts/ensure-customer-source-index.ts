#!/usr/bin/env npx tsx
/**
 * Dry-run by default. This workspace's Mongo is shared with production.
 * Apply only this one additive, non-unique index:
 * npx tsx scripts/ensure-customer-source-index.ts --apply --confirm-shared-production
 * No callback writes, provider calls, dropped indexes, or app DB helpers.
 */
import { MongoClient } from "mongodb";
import { CUSTOMER_SOURCE_INDEX, planCustomerSourceIndex } from "./lib/customer-source-index";

function mongoUri() {
  if (process.env.MONGODB_URI && !process.env.MONGODB_URI.includes("localhost")) {
    return process.env.MONGODB_URI;
  }
  const user = process.env.MONGODB_USERNAME, password = process.env.MONGODB_PASSWORD;
  if (!user || !password) throw new Error("Mongo credentials missing");
  return `mongodb+srv://${encodeURIComponent(user)}:${encodeURIComponent(password)}@mos-maintenance-mvp.tiixipi.mongodb.net/mos-maintenance-mvp`;
}

async function main() {
  const apply = process.argv.includes("--apply");
  if (apply && !process.argv.includes("--confirm-shared-production")) {
    throw new Error("Apply requires --confirm-shared-production");
  }
  const client = new MongoClient(mongoUri(), {
    maxPoolSize: 2, minPoolSize: 0, retryWrites: false,
    serverSelectionTimeoutMS: 10000, socketTimeoutMS: 330000,
  });
  try {
    await client.connect();
    const db = client.db(process.env.MONGODB_DB || "mos-maintenance-mvp", {
      writeConcern: { w: "majority", wtimeoutMS: 300000 },
    });
    const collection = db.collection("normalized_customers");
    const info = await db.listCollections({ name: collection.collectionName }, { nameOnly: false }).next();
    if (!info || (info.options?.collation && info.options.collation.locale !== "simple")) {
      throw new Error("Collection missing or non-simple default collation; manual review required");
    }
    const indexes = await collection.listIndexes().toArray();
    const plan = planCustomerSourceIndex(indexes);
    const stats = await db.command({ collStats: collection.collectionName, scale: 1, maxTimeMS: 3000 });
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", collection: collection.collectionName,
      plan, key: CUSTOMER_SOURCE_INDEX.key, documents: stats.count,
      storageBytes: stats.storageSize, totalIndexBytes: stats.totalIndexSize }));
    if (apply && plan.action === "create") {
      const started = Date.now();
      await collection.createIndex(CUSTOMER_SOURCE_INDEX.key, {
        name: CUSTOMER_SOURCE_INDEX.name, background: true, maxTimeMS: 300000,
      });
      console.log(JSON.stringify({ indexCreated: CUSTOMER_SOURCE_INDEX.name, durationMs: Date.now() - started }));
    }
    // Use a bounded _id-index sample, with no customer names/contact data.
    // Prefer a real Protractor identity; never log the identity or query values.
    const sample = await collection.find({}, { hint: "_id_", maxTimeMS: 2000,
      projection: { shopId: 1, "provenance.sourceIds": 1 } }).sort({ _id: 1 }).limit(20).toArray();
    const protractorCustomer = sample.find(row =>
      typeof row.shopId === "number" &&
      row.provenance?.sourceIds?.some((id: any) => id.system === "protractor" && typeof id.idValue === "string"));
    const customer = protractorCustomer ?? sample.find(row =>
      typeof row.shopId === "number" &&
      row.provenance?.sourceIds?.some((id: any) => typeof id.system === "string" && typeof id.idValue === "string"));
    const sourceId = customer?.provenance.sourceIds.find((id: any) =>
      typeof id.system === "string" && typeof id.idValue === "string" && (!protractorCustomer || id.system === "protractor"));
    const query = { shopId: customer?.shopId ?? -1, "provenance.sourceIds": {
      $elemMatch: sourceId ?? { system: "protractor", idType: "invoice_id", idValue: "diagnostic-placeholder", isPrimary: true },
    } };
    const after = planCustomerSourceIndex(await collection.listIndexes().toArray());
    // Before adding the index, use planner-only evidence: never execute a shop scan.
    const hasIndex = after.action === "exists";
    const explain = await db.command({
      explain: { find: collection.collectionName, filter: query, limit: 1, maxTimeMS: 3000 },
      verbosity: hasIndex ? "executionStats" : "queryPlanner",
      maxTimeMS: 3000,
    });
    const nodes: { stage?: string; indexName?: string }[] = [];
    function inspect(node: any) {
      if (!node || typeof node !== "object") return;
      if (node.stage || node.indexName) nodes.push({ stage: node.stage, indexName: node.indexName });
      for (const child of Object.values(node)) {
        if (Array.isArray(child)) child.forEach(inspect);
        else if (child && typeof child === "object") inspect(child);
      }
    }
    inspect(explain.queryPlanner?.winningPlan);
    const execution = explain.executionStats;
    console.log(JSON.stringify({ verification: after, realIdentitySample: !!customer,
      protractorIdentitySample: !!protractorCustomer, plan: nodes,
      execution: execution ? { durationMs: execution.executionTimeMillis, returned: execution.nReturned,
        keysExamined: execution.totalKeysExamined, documentsExamined: execution.totalDocsExamined } : undefined }));
    if (apply && (!hasIndex || !nodes.some(node => node.indexName === after.name))) {
      throw new Error("Index exists but unhinted lookup did not select it; manual review required");
    }
  } finally { await client.close(); }
}
main().catch(error => {
  // Driver errors can contain connection details; report only safe classifications.
  console.error(JSON.stringify({ status: "failed", name: error.name, code: error.code,
    reason: /^(Apply requires|Customer source index name conflicts|Collection missing|Index exists but|Mongo credentials missing)/.test(error.message)
      ? error.message : "Customer source index operation failed; inspect safe error code" }));
  process.exitCode = 1;
});