import { NextRequest, NextResponse } from "next/server";
import { normalizeWindowDays } from "@/lib/missed-opportunities";
import { listReportWindowVehicles } from "@/lib/missed-opportunities-service";
import {
  listMissedOppReportShops,
  findCachedPlanForVehicle,
} from "@/lib/data/repositories/missed-opportunities";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import { triggerPlanBuild } from "@/lib/vhi-rebuild";
import { resolvePeakPolicy } from "@/lib/plan-warm-peak";
import { selectPlanWarmCandidates } from "@/lib/plan-warm-selection";
import { resolvePlanWarmMileage } from "@/lib/plan-warm-mileage";
import { estimateMileageFromCarfax } from "@/lib/integrations/carfax";

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

/**
 * Task #1184 — VHI plan pre-warm for the Missed Opportunities report.
 *
 * The report is cache-only: it evaluates a closed RO only when the vehicle
 * already has a `cached_plans` entry (~4h TTL). Shops whose vehicles aren't
 * being viewed in the extension therefore see an empty report. This cron
 * warms cached plans for exactly the vehicles the report will read — the
 * newest unique VINs from terminal ROs in the shop's report window — so
 * `evaluatedRos` rises for cold shops.
 *
 * Safety design (this builds plans on the WEB process — see the plan-pregen
 * storm incident — so every dimension is capped):
 *   - **Never a paid CARFAX fetch.** Builds go through plan-build with
 *     `skipCarfax=1`: any EXISTING CARFAX snapshot is read, but no live or
 *     background CARFAX call ever fires. DataOne/OEM reads are our own
 *     cached layer (free); Tekmetric's on-demand inspection fallback inside
 *     plan-build stays budget-bounded as on any build.
 *   - **Self-selecting shops.** Targets only shops that have actually loaded
 *     the report (a report-cache doc exists), each gated by the same
 *     `estimate_assist` entitlement as the report route. `PLAN_WARM_SHOP_IDS`
 *     (comma-separated) overrides the target list for staged rollout.
 *   - **Idempotent.** VINs with a valid cached plan are skipped, so repeated
 *     runs only rebuild what the 4h TTL expired.
 *   - **Bounded.** Caps on shops/run, builds/shop, build concurrency, and a
 *     wall-clock deadline that exits before the scheduler timeout;
 *     unfinished shops resume next run (cache-hit skips make that cheap).
 *
 * Gated behind `PLAN_WARM_ENABLED=true` (default OFF) so it stays dormant
 * until an operator flips it on.
 */
export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (process.env.PLAN_WARM_ENABLED !== "true") {
    return NextResponse.json({ ok: true, skipped: "disabled" });
  }

  const startedAt = Date.now();
  const maxShops = Math.max(1, Number(process.env.PLAN_WARM_MAX_SHOPS || "20"));

  // Task #1147: plan builds run on the WEB process, so peak-hour ticks are
  // throttled (or skipped, per PLAN_WARM_PEAK_MODE) instead of spending the
  // full warm budget while real users are on the box. Off-peak ticks — and
  // the every-4h cadence that keeps plans inside the 4h TTL — are unchanged.
  const peakPolicy = resolvePeakPolicy(new Date(), {
    maxVinsPerShop: Math.max(1, Number(process.env.PLAN_WARM_MAX_VINS_PER_SHOP || "40")),
    concurrency: Math.max(1, Number(process.env.PLAN_WARM_CONCURRENCY || "2")),
  });
  if (peakPolicy.action === "skip") {
    console.log(`[PlanWarm] skipped: peak_hours (PLAN_WARM_PEAK_MODE=skip)`);
    return NextResponse.json({ ok: true, skipped: "peak_hours" });
  }
  const maxVinsPerShop = peakPolicy.maxVinsPerShop;
  const concurrency = peakPolicy.concurrency;
  const deadlineMs = Number(process.env.PLAN_WARM_DEADLINE_MS || String(4 * 60 * 1000));
  const deadlineHitRef = { hit: false };
  const pastDeadline = () => {
    if (Date.now() - startedAt > deadlineMs) {
      deadlineHitRef.hit = true;
      return true;
    }
    return false;
  };

  try {
    // 1. Warm targets: explicit operator list, else shops that have loaded
    // the report at least once.
    const shopIdsOverride = (process.env.PLAN_WARM_SHOP_IDS || "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);

    let targets: Array<{ shopId: number; windowDays: number }>;
    if (shopIdsOverride.length > 0) {
      const windowDays = normalizeWindowDays(process.env.PLAN_WARM_WINDOW_DAYS || null);
      targets = shopIdsOverride.map((shopId) => ({ shopId, windowDays }));
    } else {
      targets = await listMissedOppReportShops();
    }
    targets = targets.slice(0, maxShops);

    const perShop: Array<Record<string, unknown>> = [];
    let totalScanned = 0;
    let totalBuildsAttempted = 0;
    let totalWarmed = 0;
    let totalAlreadyCached = 0;
    let totalFailed = 0;
    let totalSkippedNoMileage = 0;

    for (const target of targets) {
      if (pastDeadline()) break;
      const { shopId } = target;
      const windowDays = normalizeWindowDays(String(target.windowDays));

      // Same entitlement gate as the report route — a stale report-cache doc
      // from a downgraded shop must not spend warm budget.
      try {
        const entitlements = await getFeatureEntitlements(shopId);
        if (!entitlements.canUseFeature("estimate_assist")) {
          perShop.push({ shopId, skipped: "not_entitled" });
          continue;
        }
      } catch (err: any) {
        perShop.push({ shopId, skipped: "entitlement_check_failed", error: err?.message });
        continue;
      }

      let vehicles: Array<{ vin: string; mileage: number | null }>;
      try {
        vehicles = await listReportWindowVehicles(shopId, windowDays);
      } catch (err: any) {
        console.warn(`[PlanWarm] Shop ${shopId}: window vehicle listing failed: ${err?.message}`);
        perShop.push({ shopId, skipped: "vehicle_listing_failed", error: err?.message });
        continue;
      }
      let warmed = 0;
      const selection = await selectPlanWarmCandidates({
        vehicles,
        maxCandidates: maxVinsPerShop,
        concurrency,
        pastDeadline,
        // Some providers rarely stamp an RO odometer. Fall back to the
        // existing CARFAX snapshot projection, which is a cache-only DB read
        // and never initiates a paid lookup.
        resolveMileage: async ({ vin, mileage }) =>
          resolvePlanWarmMileage(
            shopId,
            vin,
            mileage,
            estimateMileageFromCarfax,
          ),
        isCached: async ({ vin, mileage }) =>
          !!(await findCachedPlanForVehicle(shopId, vin, mileage)),
        onMileageResolutionError: ({ vin }, err) => {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[PlanWarm] Shop ${shopId} VIN ${vin}: mileage estimate failed: ${message}`);
        },
        onCacheLookupError: ({ vin }, err) => {
          const message = err instanceof Error ? err.message : String(err);
          console.warn(`[PlanWarm] Shop ${shopId} VIN ${vin}: cache lookup failed: ${message}`);
        },
      });
      const { pending, alreadyCached, skippedNoMileage } = selection;
      let buildsAttempted = 0;
      let failed = selection.cacheLookupFailures + selection.mileageResolutionFailures;
      let cursor = 0;

      await Promise.all(
        Array.from({ length: Math.min(concurrency, pending.length) }).map(async () => {
          while (true) {
            if (pastDeadline()) return;
            const idx = cursor++;
            if (idx >= pending.length) return;
            const {
              vin,
              mileage,
              mileageSource,
              mileageEstimateDetails,
            } = pending[idx];
            buildsAttempted++;
            try {
              const built = await triggerPlanBuild(
                shopId,
                vin,
                mileage,
                /* fast */ false,
                /* skipCarfax */ true,
                { mileageSource, mileageEstimateDetails },
              );
              if (built.ok) warmed++;
              else failed++;
            } catch (err: any) {
              console.warn(`[PlanWarm] Shop ${shopId} VIN ${vin}: warm failed: ${err?.message}`);
              failed++;
            }
          }
        }),
      );

      totalScanned += selection.scanned;
      totalBuildsAttempted += buildsAttempted;
      totalWarmed += warmed;
      totalAlreadyCached += alreadyCached;
      totalFailed += failed;
      totalSkippedNoMileage += skippedNoMileage;
      perShop.push({
        shopId,
        windowDays,
        windowVins: vehicles.length,
        scanned: selection.scanned,
        buildsAttempted,
        warmed,
        alreadyCached,
        failed,
        skippedNoMileage,
      });
    }

    const summary = {
      ok: true,
      shopsTargeted: targets.length,
      shopsProcessed: perShop.length,
      scanned: totalScanned,
      buildsAttempted: totalBuildsAttempted,
      warmed: totalWarmed,
      alreadyCached: totalAlreadyCached,
      failed: totalFailed,
      skippedNoMileage: totalSkippedNoMileage,
      peakThrottled: peakPolicy.action === "throttle",
      deadlineHit: deadlineHitRef.hit,
      durationMs: Date.now() - startedAt,
      perShop,
    };
    console.log(`[PlanWarm] ${JSON.stringify(summary)}`);
    return NextResponse.json(summary);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[PlanWarm] Error:", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
