import { NextRequest, NextResponse } from "next/server";
import { getMaintenanceScheduleCached } from "@/lib/integrations/dataone-api";
import {
  getRecentlyViewedVins,
  getFreshDataOneSquishes,
} from "@/lib/data/repositories/specs-warm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CRON_SECRET = process.env.CRON_SECRET;

// Same auth contract as the other cron routes: the in-process scheduler sends
// `Authorization: Bearer ${CRON_SECRET}`; a `?secret=` query param is accepted
// for manual curl triggers. When CRON_SECRET is unset (dev) auth is a no-op.
function authorized(req: NextRequest): boolean {
  if (!CRON_SECRET) return true;
  const header = req.headers.get("authorization");
  const param = new URL(req.url).searchParams.get("secret");
  return header === `Bearer ${CRON_SECRET}` || param === CRON_SECRET;
}

function toSquish(vin: string): string {
  const v = String(vin).toUpperCase().trim();
  return v.length >= 11 ? v.slice(0, 8) + v.slice(9, 11) : "";
}

/**
 * Specs/schedule cache warmer.
 *
 * Pre-populates the DataOne OEM maintenance-schedule cache (`dataone_cache`,
 * 7-day TTL, keyed by VIN squish) for vehicles advisors have actually viewed
 * recently, so the first plan / vehicle-health load of the day is fast instead
 * of paying the DataOne round-trip on a cold cache.
 *
 * Design choices that keep this safe to run against the shared prod DataOne DB:
 *   - **Free layer only.** Warms only `getMaintenanceScheduleCached` (our own
 *     DataOne DB, deduped by squish). It deliberately does NOT touch CARFAX —
 *     CARFAX pulls cost money per lookup, so this never triggers a paid call.
 *   - **Deduped by squish.** Many VINs share a squish, so one fetch covers
 *     many vehicles.
 *   - **Idempotent.** Squishes already cached and unexpired are skipped, so a
 *     nightly run does near-zero work once the fleet is warm.
 *   - **Bounded.** Small concurrency + a wall-clock deadline so it can never
 *     overrun the cron timeout or hammer DataOne.
 *
 * The computed-plan cache (`cached_plans`, 4h TTL) is intentionally NOT warmed
 * here: a nightly warm would be stale by mid-morning. The 7-day schedule cache
 * is the durable win and is what the on-demand plan build blocks on.
 *
 * Gated behind `SPECS_WARM_ENABLED=true` (default OFF) so it stays dormant
 * until an operator flips it on.
 */
export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (process.env.SPECS_WARM_ENABLED !== "true") {
    return NextResponse.json({ ok: true, skipped: "disabled" });
  }

  const startedAt = Date.now();
  const lookbackDays = Number(process.env.SPECS_WARM_LOOKBACK_DAYS || "30");
  const maxSquishes = Number(process.env.SPECS_WARM_MAX_SQUISHES || "500");
  const concurrency = Math.max(1, Number(process.env.SPECS_WARM_CONCURRENCY || "3"));
  const deadlineMs = Number(process.env.SPECS_WARM_DEADLINE_MS || String(5 * 60 * 1000));
  const cutoff = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);

  try {
    // 1. Recently-viewed VINs across all shops (recency = what advisors open).
    const vins = await getRecentlyViewedVins(cutoff);

    // 2. Dedup by squish — one DataOne fetch covers every VIN sharing it.
    const squishToVin = new Map<string, string>();
    for (const vin of vins) {
      const sq = toSquish(vin);
      if (sq && !squishToVin.has(sq)) squishToVin.set(sq, vin);
    }
    const allSquishes = [...squishToVin.keys()];

    // 3. Skip squishes already cached & unexpired (idempotent).
    const now = new Date();
    const fresh = await getFreshDataOneSquishes(allSquishes, now);
    const pending = allSquishes.filter((s) => !fresh.has(s)).slice(0, maxSquishes);

    // 4. Warm with bounded concurrency + a wall-clock deadline.
    let warmed = 0;
    let empty = 0;
    let failed = 0;
    let deadlineHit = false;
    let idx = 0;

    async function worker() {
      while (idx < pending.length) {
        if (Date.now() - startedAt > deadlineMs) {
          deadlineHit = true;
          return;
        }
        const sq = pending[idx++];
        const vin = squishToVin.get(sq);
        if (!vin) continue;
        try {
          const res = await getMaintenanceScheduleCached(vin);
          if (res.ok && res.count > 0) warmed++;
          else empty++;
        } catch {
          failed++;
        }
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    const summary = {
      ok: true,
      viewedVins: vins.length,
      uniqueSquishes: allSquishes.length,
      alreadyFresh: fresh.size,
      attempted: pending.length,
      warmed,
      empty,
      failed,
      deadlineHit,
      durationMs: Date.now() - startedAt,
    };
    console.log(`[SpecsWarm] ${JSON.stringify(summary)}`);
    return NextResponse.json(summary);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[SpecsWarm] Error:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
