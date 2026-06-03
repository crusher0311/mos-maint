/**
 * Pre-cutover readiness check (task #567), CLI flavor.
 *
 * Self-service go/no-go an operator runs from a shell BEFORE flipping any
 * backfill-queue flag. Prints whether Redis is reachable, how many
 * workers are consuming each queue, and what the current flags would do.
 *
 * Usage (on the web service, with the same env as production):
 *   REDIS_URL=redis://... npm run queue:readiness
 *
 * Exit codes:
 *   0 — ready (Redis reachable AND every queue has a consumer)
 *   1 — not ready (see the printed blockers)
 *
 * Read-only: it never enqueues, retries, or mutates anything.
 */

import { getQueueReadiness } from "../lib/queue/readiness";

async function main() {
  const r = await getQueueReadiness();

  console.log("=".repeat(60));
  console.log("Backfill Worker Queue — Readiness Check");
  console.log("=".repeat(60));
  console.log(`Generated: ${r.generatedAt}`);
  console.log("");

  console.log("Redis:");
  console.log(`  URL set:    ${r.redis.urlSet ? "yes" : "no"}`);
  console.log(`  Reachable:  ${r.redis.reachable ? "yes" : "no"}`);
  if (r.redis.pingMs != null) console.log(`  Ping:       ${r.redis.pingMs}ms`);
  if (r.redis.error) console.log(`  Error:      ${r.redis.error}`);
  console.log("");

  console.log(`Workers (${r.workers.totalConsuming} total consuming):`);
  for (const q of r.workers.perQueue) {
    console.log(
      `  ${q.name.padEnd(20)} ${q.workerCount} worker(s)${
        q.error ? `  [${q.error}]` : ""
      }`,
    );
  }
  console.log("");

  console.log(`Flags (effective mode: ${r.flags.effectiveMode}):`);
  console.log(`  Kill switch:    ${r.flags.killSwitch ? "ON" : "off"}`);
  console.log(`  Global enabled: ${r.flags.globalEnabled ? "ON" : "off"}`);
  console.log(
    `  Per-shop allow: ${
      r.flags.perShopAllow.length ? r.flags.perShopAllow.join(", ") : "(none)"
    }`,
  );
  for (const d of r.flags.decisions) {
    console.log(
      `    ${d.useQueue ? "→ queue " : "→ legacy"}  (${d.reason})  ${d.label}`,
    );
  }
  console.log("");

  if (r.blockers.length) {
    console.log("BLOCKERS:");
    for (const b of r.blockers) console.log(`  ⛔ ${b}`);
    console.log("");
  }
  if (r.warnings.length) {
    console.log("WARNINGS:");
    for (const w of r.warnings) console.log(`  ⚠️  ${w}`);
    console.log("");
  }

  console.log("=".repeat(60));
  console.log(r.ok ? "VERDICT: READY ✅" : "VERDICT: NOT READY ❌");
  console.log("=".repeat(60));

  process.exit(r.ok ? 0 : 1);
}

main().catch((err) => {
  console.error("queue-readiness-check failed:", err);
  process.exit(1);
});
