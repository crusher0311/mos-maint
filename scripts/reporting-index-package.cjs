// Print-only operator package. Importing or running this file never connects.
const mongoIndexes = [
  { name: "report_queue_claim", key: { status: 1, queuedAt: 1, attempts: 1 } },
  { name: "report_queue_recovery", key: { status: 1, heartbeatAt: 1, queuedAt: 1, attempts: 1 } },
  { name: "report_active_refresh", key: { status: 1, refreshEnabled: 1, lastViewedAt: -1, generatedAt: 1 } },
];
const postgresIndexes = [
  { name: "normalized_payments_shop_work_order_idx", table: "normalized_payments", columns: ["shop_id", "work_order_id"] },
  { name: "normalized_service_jobs_shop_work_order_idx", table: "normalized_service_jobs", columns: ["shop_id", "work_order_id"] },
  { name: "viewed_vins_shop_last_viewed_idx", table: "viewed_vins", columns: ["shop_id", "last_viewed_at"] },
];
const postgresStatements = postgresIndexes.map(i =>
  `CREATE INDEX CONCURRENTLY ${i.name} ON public.${i.table} (${i.columns.join(", ")});`);
module.exports = { mongoIndexes, postgresIndexes, postgresStatements };
if (require.main === module) {
  console.log("-- REVIEW ONLY: no connection or execution. Apply one statement at a time after approval.");
  console.log("-- PostgreSQL: fresh catalog/health check first. No transaction wrapper.");
  console.log("SET lock_timeout = '2s';\nSET statement_timeout = '20min';");
  console.log(postgresStatements.join("\n"));
  console.log("\n// MongoDB: verify database is mos-maintenance-mvp; execute separately, one at a time.");
  for (const { key, name } of mongoIndexes) {
    console.log(`db.getCollection("report_runs").createIndex(${JSON.stringify(key)}, ${JSON.stringify({ name, maxTimeMS: 1200000 })});`);
  }
}
