import { getDb } from "../lib/mongo";

const STALE_RUN_HOURS = 48;
const FROZEN_CURSOR_DAYS = 3;
const SPOT_SHOPS = [32, 36, 37, 54, 57, 73, 74, 75];

function fmtDate(d: any): string {
  if (!d) return "—";
  const t = new Date(d);
  return isNaN(t.getTime()) ? String(d) : t.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

async function main() {
  const db = await getDb();
  const progress = await db
    .collection("tekmetric_backfill_progress")
    .find({})
    .toArray();

  const now = Date.now();
  const total = progress.length;
  const completed = progress.filter((p: any) => p.completed).length;
  const incomplete = progress.filter((p: any) => !p.completed);

  const diagnostics = incomplete
    .map((p: any) => {
      const lastRunMs = p.lastRunAt ? new Date(p.lastRunAt).getTime() : null;
      const hoursSinceRun = lastRunMs == null ? null : (now - lastRunMs) / 3_600_000;
      const cursorMoveMs = p.lastCursorMoveAt
        ? new Date(p.lastCursorMoveAt).getTime()
        : lastRunMs;
      const daysCursorFrozen =
        cursorMoveMs == null ? null : (now - cursorMoveMs) / 86_400_000;

      const reasons: string[] = [];
      if (lastRunMs == null) reasons.push("never_started");
      if (hoursSinceRun != null && hoursSinceRun > STALE_RUN_HOURS) reasons.push("stale_run");
      if (daysCursorFrozen != null && daysCursorFrozen > FROZEN_CURSOR_DAYS) reasons.push("frozen_cursor");
      if (p.lastError) reasons.push("last_error");

      return {
        shopId: p.shopId,
        stuck: reasons.length > 0,
        reasons,
        lastRunAt: p.lastRunAt || null,
        hoursSinceLastRun: hoursSinceRun == null ? null : Number(hoursSinceRun.toFixed(1)),
        currentChunkEnd: p.currentChunkEnd || null,
        previousChunkEnd: p.previousChunkEnd || null,
        lastCursorMoveAt: p.lastCursorMoveAt || null,
        daysCursorFrozen:
          daysCursorFrozen == null ? null : Number(daysCursorFrozen.toFixed(1)),
        lastError: p.lastError || null,
        lastErrorAt: p.lastErrorAt || null,
        autoClearedErrorAt: p.autoClearedErrorAt || null,
        totalJobsIndexed: p.totalJobsIndexed || 0,
        logicVersion: p.logicVersion || null,
      };
    })
    .sort((a, b) => {
      if (a.stuck !== b.stuck) return a.stuck ? -1 : 1;
      return (b.daysCursorFrozen ?? -1) - (a.daysCursorFrozen ?? -1);
    });

  const stuckCount = diagnostics.filter((d) => d.stuck).length;
  const neverStarted = diagnostics.filter((d) => d.reasons.includes("never_started"));
  const staleRun = diagnostics.filter((d) => d.reasons.includes("stale_run"));
  const frozenCursor = diagnostics.filter((d) => d.reasons.includes("frozen_cursor"));
  const withLastError = diagnostics.filter((d) => d.reasons.includes("last_error"));

  console.log("=".repeat(72));
  console.log("Tekmetric backfill verification");
  console.log("Run at:", new Date().toISOString());
  console.log("=".repeat(72));
  console.log(`Shops total:        ${total}`);
  console.log(`Shops completed:    ${completed}`);
  console.log(`Shops incomplete:   ${incomplete.length}`);
  console.log(`Shops stuck:        ${stuckCount}`);
  console.log(`  never_started:    ${neverStarted.length}`);
  console.log(`  stale_run (>48h): ${staleRun.length}`);
  console.log(`  frozen_cursor (>3d): ${frozenCursor.length}`);
  console.log(`  last_error:       ${withLastError.length}`);
  console.log("");

  // (a) every incomplete shop has a recent lastRunAt (within ~48h)
  console.log("─".repeat(72));
  console.log("(a) Incomplete-shop freshness (target: lastRunAt within 48h)");
  console.log("─".repeat(72));
  if (staleRun.length === 0 && neverStarted.length === 0) {
    console.log("PASS — all incomplete shops have lastRunAt within 48h");
  } else {
    console.log(
      `FAIL — ${staleRun.length} stale-run shop(s), ${neverStarted.length} never-started shop(s)`,
    );
    for (const d of [...neverStarted, ...staleRun]) {
      console.log(
        `  shop=${d.shopId}  lastRunAt=${fmtDate(d.lastRunAt)}  hoursSinceRun=${d.hoursSinceLastRun ?? "—"}  reasons=${d.reasons.join(",")}`,
      );
    }
  }
  console.log("");

  // (b) cursors are advancing backwards run-over-run
  console.log("─".repeat(72));
  console.log("(b) Cursor advancement (currentChunkEnd should be < previousChunkEnd)");
  console.log("─".repeat(72));
  const advancing: any[] = [];
  const notAdvancing: any[] = [];
  const noPrev: any[] = [];
  for (const d of diagnostics) {
    if (!d.currentChunkEnd) {
      noPrev.push(d);
      continue;
    }
    if (!d.previousChunkEnd) {
      noPrev.push(d);
      continue;
    }
    const cur = new Date(d.currentChunkEnd).getTime();
    const prev = new Date(d.previousChunkEnd).getTime();
    if (cur < prev) advancing.push(d);
    else notAdvancing.push(d);
  }
  console.log(`Advancing backwards (good): ${advancing.length}`);
  console.log(`Not advancing:              ${notAdvancing.length}`);
  console.log(`No previousChunkEnd yet:    ${noPrev.length}`);
  if (notAdvancing.length > 0) {
    console.log("Shops with NO cursor movement run-over-run:");
    for (const d of notAdvancing) {
      console.log(
        `  shop=${d.shopId}  current=${fmtDate(d.currentChunkEnd)}  previous=${fmtDate(d.previousChunkEnd)}  daysFrozen=${d.daysCursorFrozen ?? "—"}`,
      );
    }
  }
  console.log("");

  // (c) the 19 previously never-started shops have begun
  console.log("─".repeat(72));
  console.log("(c) Previously never-started shops (should now have lastRunAt)");
  console.log("─".repeat(72));
  if (neverStarted.length === 0) {
    console.log("PASS — no incomplete shops are missing lastRunAt");
  } else {
    console.log(`FAIL — ${neverStarted.length} shop(s) still have no lastRunAt:`);
    for (const d of neverStarted) {
      console.log(
        `  shop=${d.shopId}  totalJobsIndexed=${d.totalJobsIndexed}  logicVersion=${d.logicVersion ?? "—"}`,
      );
    }
  }
  console.log("");

  // (d) no shop is silently stuck on a repeating error
  console.log("─".repeat(72));
  console.log("(d) Shops with current lastError");
  console.log("─".repeat(72));
  if (withLastError.length === 0) {
    console.log("PASS — no shops have an unresolved lastError");
  } else {
    for (const d of withLastError) {
      console.log(
        `  shop=${d.shopId}  lastErrorAt=${fmtDate(d.lastErrorAt)}  autoClearedErrorAt=${fmtDate(d.autoClearedErrorAt)}  error=${String(d.lastError).slice(0, 200)}`,
      );
    }
  }
  console.log("");

  // Spot checks
  console.log("─".repeat(72));
  console.log("Spot checks: long-stalled shops (32, 36, 37, 54, 57, 73, 74, 75)");
  console.log("─".repeat(72));
  const byShop = new Map<number, any>();
  for (const p of progress) byShop.set(Number(p.shopId), p);
  for (const id of SPOT_SHOPS) {
    const p: any = byShop.get(id);
    if (!p) {
      console.log(`  shop=${id}  (no progress row found)`);
      continue;
    }
    const d = diagnostics.find((x) => Number(x.shopId) === id);
    const stuckLabel = p.completed ? "COMPLETED" : d ? (d.stuck ? `STUCK (${d.reasons.join(",")})` : "OK") : "OK";
    console.log(
      `  shop=${id}  ${stuckLabel}  current=${fmtDate(p.currentChunkEnd)}  previous=${fmtDate(p.previousChunkEnd)}  lastRunAt=${fmtDate(p.lastRunAt)}  lastCursorMoveAt=${fmtDate(p.lastCursorMoveAt)}  totalJobsIndexed=${p.totalJobsIndexed ?? 0}  lastError=${p.lastError ? String(p.lastError).slice(0, 120) : "—"}`,
    );
  }
  console.log("");

  // Full incomplete-shop table for the record
  console.log("─".repeat(72));
  console.log("Full incomplete-shop diagnostics (most-stuck first)");
  console.log("─".repeat(72));
  for (const d of diagnostics) {
    console.log(
      `shop=${d.shopId}  stuck=${d.stuck}  reasons=[${d.reasons.join(",")}]  lastRunAt=${fmtDate(d.lastRunAt)}  hSince=${d.hoursSinceLastRun ?? "—"}  curEnd=${fmtDate(d.currentChunkEnd)}  prevEnd=${fmtDate(d.previousChunkEnd)}  cursorMove=${fmtDate(d.lastCursorMoveAt)}  daysFrozen=${d.daysCursorFrozen ?? "—"}  jobs=${d.totalJobsIndexed}`,
    );
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("verify-tekmetric-backfill failed:", err);
  process.exit(1);
});
