import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { requirePlatformAdmin } from "@/lib/auth";

// Test seam: the smoke suite swaps these out so the aggregation transform
// can be exercised against canned grouped rows without a real Mongo and
// without a Next.js request context for the platform-admin guard.
export const __deps = {
  getDb,
  requirePlatformAdmin,
};

// Per-shop / per-endpoint Tekmetric health rollup, computed off the
// `tekmetric_endpoint_reports` collection that the Chrome extension's
// `tekmetricFetch` helper writes to. Designed to be called from the
// platform-admin sync-health page; sorted worst-first so the rows that
// matter render at the top.
const LOOKBACK_DAYS = 7;

// Endpoints with fewer than this many samples in the window aren't
// flagged as 100% failing — one stray request from a curious dev is
// not a Tekmetric outage signal.
const MIN_SAMPLES_FOR_FULL_FAILURE = 3;

type EndpointRollup = {
  mosShopId: number | null;
  smsShopId: string | null;
  endpointShape: string;
  total: number;
  errors: number;
  errorRate: number;
  fullyFailing: boolean;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  medianElapsedMs: number | null;
  p95ElapsedMs: number | null;
  recentStatuses: number[];
};

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

export async function GET() {
  try {
    await __deps.requirePlatformAdmin();
    const db = await __deps.getDb();

    const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

    const pipeline = [
      { $match: { occurredAt: { $gte: since } } },
      // Sort before $group so the `$push`-ed `recentStatuses` array is
      // strictly chronological. Without this, MongoDB doesn't guarantee
      // input order to $group across query plans, and the "recent
      // statuses" hint in the admin panel could be out of order.
      { $sort: { occurredAt: 1 } },
      {
        $group: {
          _id: {
            mosShopId: "$mosShopId",
            smsShopId: "$smsShopId",
            endpointShape: "$endpointShape",
          },
          total: { $sum: 1 },
          errors: { $sum: { $cond: ["$isError", 1, 0] } },
          lastFailureAt: {
            $max: {
              $cond: ["$isError", "$occurredAt", null],
            },
          },
          lastSuccessAt: {
            $max: {
              $cond: [{ $not: ["$isError"] }, "$occurredAt", null],
            },
          },
          elapsedMs: { $push: "$elapsedMs" },
          recentStatuses: { $push: "$status" },
        },
      },
      // Sort worst-first: highest error rate, then highest absolute
      // error count, then most-recent activity. Done client-side too as
      // a defensive backup, but doing it in the pipeline keeps payload
      // ordering stable when the page renders.
      {
        $addFields: {
          errorRate: {
            $cond: [
              { $eq: ["$total", 0] },
              0,
              { $divide: ["$errors", "$total"] },
            ],
          },
        },
      },
      { $sort: { errorRate: -1, errors: -1, lastFailureAt: -1 } },
      { $limit: 500 },
    ];

    const rows = await db
      .collection("tekmetric_endpoint_reports")
      .aggregate(pipeline)
      .toArray();

    const rollups: EndpointRollup[] = rows.map((r: any) => {
      const total = Number(r.total || 0);
      const errors = Number(r.errors || 0);
      const errorRate = total > 0 ? errors / total : 0;
      const elapsedSorted = (r.elapsedMs || [])
        .filter((v: any) => Number.isFinite(v))
        .slice()
        .sort((a: number, b: number) => a - b);
      const median = percentile(elapsedSorted, 50);
      const p95 = percentile(elapsedSorted, 95);
      // Truncate the per-row status sample so the response stays small
      // even for chatty endpoints — the panel just needs a hint of the
      // recent failure pattern.
      const recentStatuses = (r.recentStatuses || []).slice(-10);
      return {
        mosShopId:
          r._id?.mosShopId == null ? null : Number(r._id.mosShopId),
        smsShopId: r._id?.smsShopId == null ? null : String(r._id.smsShopId),
        endpointShape: String(r._id?.endpointShape || ""),
        total,
        errors,
        errorRate: Number(errorRate.toFixed(4)),
        fullyFailing:
          errorRate >= 1 && total >= MIN_SAMPLES_FOR_FULL_FAILURE,
        lastFailureAt: r.lastFailureAt
          ? new Date(r.lastFailureAt).toISOString()
          : null,
        lastSuccessAt: r.lastSuccessAt
          ? new Date(r.lastSuccessAt).toISOString()
          : null,
        medianElapsedMs: median == null ? null : Math.round(median),
        p95ElapsedMs: p95 == null ? null : Math.round(p95),
        recentStatuses,
      };
    });

    const fullyFailingCount = rollups.filter((r) => r.fullyFailing).length;
    const totalRequests = rollups.reduce((sum, r) => sum + r.total, 0);
    const totalErrors = rollups.reduce((sum, r) => sum + r.errors, 0);
    const overallErrorRate =
      totalRequests > 0 ? Number((totalErrors / totalRequests).toFixed(4)) : 0;

    return NextResponse.json({
      lookbackDays: LOOKBACK_DAYS,
      since: since.toISOString(),
      generatedAt: new Date().toISOString(),
      totalRequests,
      totalErrors,
      overallErrorRate,
      fullyFailingCount,
      minSamplesForFullFailure: MIN_SAMPLES_FOR_FULL_FAILURE,
      rows: rollups,
    });
  } catch (err: any) {
    console.error(
      "[Admin Tekmetric Endpoint Health] Error:",
      err?.message || err,
    );
    return NextResponse.json(
      { error: err?.message || "Internal server error" },
      { status: 500 },
    );
  }
}
