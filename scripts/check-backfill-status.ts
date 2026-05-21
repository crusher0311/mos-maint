import { getDb } from "../lib/mongo";

async function main() {
  const db = await getDb();
  const rows = await db.collection("tekmetric_backfill_progress").find({}).toArray();
  const protractorRows = await db
    .collection("protractor_backfill_progress").find({}).toArray().catch(() => []);
  const drainLock = await db.collection("tekmetric_drain_lock").findOne({});
  const protractorDrainLock = await db.collection("protractor_drain_lock").findOne({}).catch(() => null);

  const now = Date.now();

  function summarize(label: string, rows: any[], collection: string) {
    let complete = 0, inProgress = 0, stalled = 0, errored = 0, neverRan = 0;
    const active: any[] = [], stuck: any[] = [], errors: any[] = [];
    for (const r of rows as any[]) {
      const done = r.completed === true || r.complete === true;
      const lastTick = r.lastRunAt || r.lastFullPageRunAt || r.lastPrePassRunAt || r.updatedAt;
      const ageMin = lastTick ? Math.round((now - new Date(lastTick).getTime()) / 60000) : null;
      const inFlight = r.inFlightUntil && new Date(r.inFlightUntil).getTime() > now;
      if (done) { complete++; continue; }
      if (!lastTick) { neverRan++; continue; }
      if (r.lastError) {
        errored++;
        errors.push({ shopId: r.shopId, lastError: String(r.lastError).slice(0, 160), ageMin });
        continue;
      }
      if (inFlight || (ageMin != null && ageMin < 15)) {
        inProgress++;
        active.push({
          shopId: r.shopId,
          page: r.fullPageNextPage ?? null,
          totalPages: r.fullPageTotalPages ?? null,
          prePassDone: !!r.prePassDone,
          prePassPage: r.prePassNextPage ?? null,
          prePassTotal: r.prePassTotalPages ?? null,
          ageMin, inFlight: !!inFlight,
        });
      } else if (ageMin != null && ageMin > 60) {
        stalled++;
        stuck.push({
          shopId: r.shopId, ageMin,
          page: r.fullPageNextPage ?? null,
          totalPages: r.fullPageTotalPages ?? null,
          prePassDone: !!r.prePassDone,
        });
      } else { inProgress++; }
    }
    console.log(`\n=== ${label} (${collection}, ${rows.length} shops) ===`);
    console.log(`  complete: ${complete} | in progress: ${inProgress} | stalled >1h: ${stalled} | errored: ${errored} | never ran: ${neverRan}`);
    if (active.length) {
      console.log(`  Active:`);
      for (const a of active.slice(0, 15)) {
        const pct = a.totalPages ? Math.round((a.page / a.totalPages) * 100) : null;
        console.log(`    shop=${a.shopId} fullPage=${a.page ?? "?"}/${a.totalPages ?? "?"}${pct != null ? ` (${pct}%)` : ""} prePass=${a.prePassDone ? "done" : `${a.prePassPage ?? "?"}/${a.prePassTotal ?? "?"}`} last=${a.ageMin}m${a.inFlight ? " [in-flight]" : ""}`);
      }
    }
    if (errors.length) {
      console.log(`  Errored:`);
      for (const e of errors.slice(0, 10)) console.log(`    shop=${e.shopId} (${e.ageMin}m): ${e.lastError}`);
    }
    if (stuck.length) {
      console.log(`  Stalled >1h (top 8 by staleness):`);
      stuck.sort((a, b) => b.ageMin - a.ageMin);
      for (const s of stuck.slice(0, 8)) {
        const pct = s.totalPages ? Math.round((s.page / s.totalPages) * 100) : null;
        console.log(`    shop=${s.shopId} fullPage=${s.page ?? "?"}/${s.totalPages ?? "?"}${pct != null ? ` (${pct}%)` : ""} prePass=${s.prePassDone ? "done" : "pending"} last=${s.ageMin > 1440 ? `${Math.round(s.ageMin / 60)}h` : `${s.ageMin}m`} ago`);
      }
    }
  }

  console.log("=== DRAIN LOCKS (Render background worker) ===");
  const fmtLock = (l: any) => {
    if (!l) return "  none — drain not currently holding lease";
    const exp = l.expiresAt ? new Date(l.expiresAt).getTime() : null;
    const live = exp != null && exp > now;
    const ageS = l.acquiredAt ? Math.round((now - new Date(l.acquiredAt).getTime()) / 1000) : null;
    return `  owner=${l.owner || l.lockOwner || "?"} live=${live} acquiredAt=${l.acquiredAt} (${ageS}s ago) expiresAt=${l.expiresAt}${live ? "" : " — EXPIRED"}`;
  };
  console.log(`Tekmetric drain lock:\n${fmtLock(drainLock)}`);
  console.log(`Protractor drain lock:\n${fmtLock(protractorDrainLock)}`);

  summarize("Tekmetric", rows, "tekmetric_backfill_progress");
  summarize("Protractor", protractorRows, "protractor_backfill_progress");

  // Recent catchup runs (the cron's ledger, separate from the drain worker)
  try {
    const recent = await db.collection("tekmetric_catchup_runs")
      .find({}).sort({ startedAt: -1 }).limit(5).toArray();
    if (recent.length) {
      console.log(`\n=== Recent cron catchup runs (top 5, newest first) ===`);
      for (const r of recent as any[]) {
        const startedAgo = r.startedAt ? Math.round((now - new Date(r.startedAt).getTime()) / 60000) : null;
        const durMs = r.finishedAt && r.startedAt
          ? new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime() : null;
        console.log(`  ${r.startedAt} (${startedAgo}m ago) ok=${r.success} shops=${r.shopsProcessed} ros=${r.rosProcessed} dur=${durMs != null ? `${Math.round(durMs / 1000)}s` : "?"}`);
      }
    }
  } catch {}

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
