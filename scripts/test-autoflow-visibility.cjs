// Each test gets an isolated module cache and offline dependency seams.
const { spawnSync } = require("node:child_process");
const tests = [
  "autoflow-admin-unseen-number",
  "autoflow-admin-route",
  "autoflow-workflow",
  "autoflow-dashboard-outbox",
  "autoflow-dashboard-notification-integration",
  "autoflow-workflow-pg-concurrency",
  "autoflow-workflow-route-auth",
  "autoflow-dashboard-classification",
  "autoflow-dashboard-aggregation",
  "autoflow-dashboard-tenant-safety",
  "autoflow-merge-task-254",
  "dashboard-updates",
  "dashboard-refresh",
  "dashboard-strict-mode",
];
for (const name of tests) {
  const result = spawnSync(process.execPath, [
    require.resolve("tsx/cli"),
    `tests/${name}.smoke.ts`,
  ], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}