import { getDb } from "../lib/mongo";

async function main() {
  const db = await getDb();
  const rows = await db
    .collection("tekmetric_backfill_progress")
    .find({})
    .toArray();

  const now = Date.now();
  let complete = 0, inProgress = 0, stalled = 0, errored = 0, neverRan = 0;
  let active: any[] = [];
  let errors: any[] = [];
  let stuck: any[] = [];

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
        ageMin,
        inFlight: !!inFlight,
      });
    } else if (ageMin != null && ageMin > 60) {
      stalled++;
      stuck.push({
        shopId: r.shopId,
        ageMin,
        page: r.fullPageNextPage ?? null,
        totalPages: r.fullPageTotalPages ?? null,
        prePassDone: !!r.prePassDone,
      });
    } else {
      inProgress++;
    }
  }

  console.log(`Tekmetric full-page backfill — ${rows.length} shops tracked`);
  console.log(`  complete:    ${complete}`);
  console.log(`  in progress: ${inProgress}`);
  console.log(`  stalled >1h: ${stalled}`);
  console.log(`  errored:     ${errored}`);
  console.log(`  never ran:   ${neverRan}`);

  if (active.length) {
    console.log(`\nActive shops (in-flight or ticked within 15m):`);
    for (const a of active.slice(0, 15)) {
      const pct = a.totalPages ? Math.round((a.page / a.totalPages) * 100) : null;
      console.log(`  shop=${a.shopId} fullPage=${a.page ?? "?"}/${a.totalPages ?? "?"}${pct != null ? ` (${pct}%)` : ""} prePass=${a.prePassDone ? "done" : `${a.prePassPage ?? "?"}/${a.prePassTotal ?? "?"}`} last=${a.ageMin}m ago${a.inFlight ? " [in-flight]" : ""}`);
    }
  }

  if (errors.length) {
    console.log(`\nShops with last_error set:`);
    for (const e of errors.slice(0, 10)) {
      console.log(`  shop=${e.shopId} (${e.ageMin}m ago): ${e.lastError}`);
    }
  }

  if (stuck.length) {
    console.log(`\nShops stalled >1h (not in-flight, no recent tick, no error):`);
    for (const s of stuck.slice(0, 10)) {
      const pct = s.totalPages ? Math.round((s.page / s.totalPages) * 100) : null;
      console.log(`  shop=${s.shopId} fullPage=${s.page ?? "?"}/${s.totalPages ?? "?"}${pct != null ? ` (${pct}%)` : ""} prePass=${s.prePassDone ? "done" : "pending"} last=${Math.round(s.ageMin / 60)}h ago`);
    }
  }

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
