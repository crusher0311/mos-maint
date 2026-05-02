import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { sendEmail } from "@/lib/email";

/**
 * Test seam: the route handler dereferences `__deps.getDb` /
 * `__deps.sendEmail` at call time so the route-level smoke test can swap
 * in fakes without spinning up Mongo or Resend. Production callers should
 * never touch this object — it defaults to the real implementations and
 * is only mutated by `tests/tekmetric-endpoint-health.route.smoke.ts`.
 */
export const __deps = {
  getDb,
  sendEmail,
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Tekmetric endpoint outage alerter — companion to Task #224's pull-only
 * platform-admin sync-health page. The dashboard surfaces per-shop
 * endpoint failure rates from `tekmetric_endpoint_reports`, but nobody
 * watches it 24/7. This cron scans the same collection over a short
 * rolling window and pages on-call when a Tekmetric endpoint shape is
 * regressed for the whole fleet, not just one shop.
 *
 * An endpointShape fires an alert when EITHER:
 *  - it is fully failing (errorRate = 1, with at least
 *    `MIN_SAMPLES_PER_SHOP` samples) for at least
 *    `FULLY_FAILING_SHOP_THRESHOLD` distinct shops; OR
 *  - the global error rate across all shops in the window is at or above
 *    `GLOBAL_ERROR_RATE_THRESHOLD`, with at least `GLOBAL_MIN_SAMPLES`
 *    total observations to suppress small-N noise.
 *
 * Dedup: one row per firing endpointShape in
 * `tekmetric_endpoint_health_alerts` (keyed by `_id: endpointShape`).
 * Re-running the cron while a shape is still firing is a no-op for that
 * shape. When the shape stops triggering, the row is deleted so the next
 * regression re-pages on-call.
 *
 * Auth: standard `Authorization: Bearer ${CRON_SECRET}`, matching every
 * other cron under `app/api/cron/`.
 */

// Rolling window. Short enough to catch fresh outages quickly, long
// enough to accumulate sample counts above the noise floor for low-RPS
// endpoints.
const WINDOW_MINUTES = 30;

// Per-shop noise floor: a shop with fewer than this many samples for
// the endpoint isn't counted as "fully failing", same threshold as the
// admin panel.
const MIN_SAMPLES_PER_SHOP = 3;

// Fleet-wide trigger: how many distinct shops must be fully failing
// before we page. Three keeps a single misbehaving shop from waking
// on-call but still trips quickly on a real Tekmetric regression.
const FULLY_FAILING_SHOP_THRESHOLD = 3;

// Global-rate trigger: cross-shop error rate at or above this fires
// even when no individual shop is fully failing (e.g. a degraded
// endpoint returning 500s ~60% of the time across the fleet).
const GLOBAL_ERROR_RATE_THRESHOLD = 0.5;

// And we require at least this many total observations for the shape
// in the window before the global-rate trigger can fire — without it,
// 4 errors out of 5 calls from a single dev would wake on-call.
const GLOBAL_MIN_SAMPLES = 20;

const ALERTS_COLLECTION = "tekmetric_endpoint_health_alerts";

type ShapeStats = {
  endpointShape: string;
  totalRequests: number;
  totalErrors: number;
  errorRate: number;
  fullyFailingShops: number;
  affectedShops: Array<{ mosShopId: number | null; smsShopId: string | null; total: number; errors: number }>;
  reasons: string[];
};

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  const expected = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : "";
  if (expected && auth !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await __deps.getDb();
  const since = new Date(Date.now() - WINDOW_MINUTES * 60 * 1000);

  // Pull raw reports in the window. The admin panel uses a heavier
  // aggregation (percentiles, recent-status sample arrays); for paging
  // we just need totals per (shape, shop) and a global tally per shape,
  // so we group in JS to keep the query simple and the test seam small.
  const reports = (await db
    .collection("tekmetric_endpoint_reports")
    .find(
      { occurredAt: { $gte: since } },
      {
        projection: {
          endpointShape: 1,
          mosShopId: 1,
          smsShopId: 1,
          isError: 1,
          occurredAt: 1,
        },
      },
    )
    .toArray()) as Array<{
    endpointShape?: string;
    mosShopId?: number | null;
    smsShopId?: string | null;
    isError?: boolean;
  }>;

  // shape -> shopKey -> {total, errors, mosShopId, smsShopId}
  const byShape = new Map<
    string,
    Map<
      string,
      { total: number; errors: number; mosShopId: number | null; smsShopId: string | null }
    >
  >();

  for (const r of reports) {
    const shape = typeof r.endpointShape === "string" ? r.endpointShape : "";
    if (!shape) continue;
    const mosShopId = r.mosShopId == null ? null : Number(r.mosShopId);
    const smsShopId = r.smsShopId == null ? null : String(r.smsShopId);
    // Reports without any shop attribution still reflect a real call;
    // keep them under a sentinel key so they roll up into the global
    // rate but never count toward "distinct shops fully failing".
    const shopKey =
      mosShopId != null
        ? `mos:${mosShopId}`
        : smsShopId != null
          ? `sms:${smsShopId}`
          : "_unattributed";

    let shopMap = byShape.get(shape);
    if (!shopMap) {
      shopMap = new Map();
      byShape.set(shape, shopMap);
    }
    let cell = shopMap.get(shopKey);
    if (!cell) {
      cell = { total: 0, errors: 0, mosShopId, smsShopId };
      shopMap.set(shopKey, cell);
    }
    cell.total += 1;
    if (r.isError) cell.errors += 1;
  }

  const firing: ShapeStats[] = [];
  const allShapeStats: ShapeStats[] = [];

  for (const [shape, shopMap] of byShape.entries()) {
    let totalRequests = 0;
    let totalErrors = 0;
    let fullyFailingShops = 0;
    const affected: ShapeStats["affectedShops"] = [];

    for (const [shopKey, cell] of shopMap.entries()) {
      totalRequests += cell.total;
      totalErrors += cell.errors;
      const isAttributed = shopKey !== "_unattributed";
      const shopErrorRate = cell.total > 0 ? cell.errors / cell.total : 0;
      if (
        isAttributed &&
        cell.total >= MIN_SAMPLES_PER_SHOP &&
        shopErrorRate >= 1
      ) {
        fullyFailingShops += 1;
        affected.push({
          mosShopId: cell.mosShopId,
          smsShopId: cell.smsShopId,
          total: cell.total,
          errors: cell.errors,
        });
      }
    }

    const errorRate = totalRequests > 0 ? totalErrors / totalRequests : 0;
    const reasons: string[] = [];
    if (fullyFailingShops >= FULLY_FAILING_SHOP_THRESHOLD) {
      reasons.push(
        `${fullyFailingShops} shops fully failing (>= ${FULLY_FAILING_SHOP_THRESHOLD})`,
      );
    }
    if (
      totalRequests >= GLOBAL_MIN_SAMPLES &&
      errorRate >= GLOBAL_ERROR_RATE_THRESHOLD
    ) {
      reasons.push(
        `global error rate ${(errorRate * 100).toFixed(1)}% over ${totalRequests} calls (>= ${(GLOBAL_ERROR_RATE_THRESHOLD * 100).toFixed(0)}%)`,
      );
    }

    const stats: ShapeStats = {
      endpointShape: shape,
      totalRequests,
      totalErrors,
      errorRate,
      fullyFailingShops,
      affectedShops: affected,
      reasons,
    };
    allShapeStats.push(stats);
    if (reasons.length > 0) firing.push(stats);
  }

  // Compare current firing set with persisted alert state to determine
  // newly-firing (insert + page) vs. recovered (delete dedup row).
  const alertsCol = db.collection(ALERTS_COLLECTION);
  await alertsCol
    .createIndex({ endpointShape: 1 }, { unique: true, name: "uniq_endpointShape" })
    .catch(() => {});

  const existingAlerts = (await alertsCol.find({}).toArray()) as Array<{
    _id?: any;
    endpointShape: string;
  }>;
  const existingShapes = new Set(existingAlerts.map((a) => a.endpointShape));
  const firingShapes = new Set(firing.map((f) => f.endpointShape));

  const newAlerts: ShapeStats[] = firing.filter(
    (f) => !existingShapes.has(f.endpointShape),
  );
  const recovered: string[] = [];
  for (const shape of existingShapes) {
    if (!firingShapes.has(shape)) recovered.push(shape);
  }

  // Insert dedup rows for new alerts. Insert is per-shape so a single
  // duplicate-key race (another scheduler instance landing the same
  // alert microseconds earlier) only suppresses that one shape.
  const actuallyInserted: ShapeStats[] = [];
  for (const f of newAlerts) {
    try {
      await alertsCol.insertOne({
        endpointShape: f.endpointShape,
        firstFiredAt: new Date(),
        reasons: f.reasons,
        fullyFailingShops: f.fullyFailingShops,
        totalRequests: f.totalRequests,
        totalErrors: f.totalErrors,
        errorRate: Number(f.errorRate.toFixed(4)),
      });
      actuallyInserted.push(f);
    } catch (err: any) {
      if (err?.code !== 11000) {
        console.error(
          `[TekmetricEndpointHealth] Alert dedup failed for ${f.endpointShape}:`,
          err?.message,
        );
      }
    }
  }

  // Clear dedup rows for recovered shapes so the next outage repages.
  if (recovered.length > 0) {
    await alertsCol.deleteMany({ endpointShape: { $in: recovered } });
  }

  // Send a single consolidated email per cron run when there's anything
  // newly firing. Recovery does not page — it just clears state — to
  // match how the webhook-health alerter behaves.
  let emailed = 0;
  if (actuallyInserted.length > 0) {
    const admins = (await db
      .collection("users")
      .find(
        { isPlatformAdmin: true, email: { $exists: true, $ne: null } },
        { projection: { email: 1 } },
      )
      .toArray()) as Array<{ email: string }>;

    if (admins.length === 0) {
      console.warn(
        "[TekmetricEndpointHealth] No platform admins configured; alerts logged only",
      );
    } else {
      const rows = actuallyInserted
        .map(
          (f) => `
        <tr>
          <td style="padding:6px 12px;border:1px solid #ddd"><code>${f.endpointShape}</code></td>
          <td style="padding:6px 12px;border:1px solid #ddd">${f.fullyFailingShops}</td>
          <td style="padding:6px 12px;border:1px solid #ddd">${f.totalErrors} / ${f.totalRequests} (${(f.errorRate * 100).toFixed(1)}%)</td>
          <td style="padding:6px 12px;border:1px solid #ddd">${f.reasons.join("; ")}</td>
        </tr>`,
        )
        .join("");
      const html = `
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5">
          <h2>Tekmetric Endpoint Outage — On-call Page</h2>
          <p>The following ${actuallyInserted.length} Tekmetric endpoint shape(s) crossed alert thresholds in the last ${WINDOW_MINUTES} minutes.</p>
          <table style="border-collapse:collapse;border:1px solid #ddd">
            <thead>
              <tr>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Endpoint shape</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Fully failing shops</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Errors / total</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Trigger</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          <p style="margin-top:16px;color:#666;font-size:13px">
            Sent by <code>/api/cron/tekmetric-endpoint-health</code> · Drill-down:
            <code>/api/admin/tekmetric-endpoint-health</code>
          </p>
        </div>`;
      for (const admin of admins) {
        try {
          await __deps.sendEmail({
            to: admin.email,
            subject: `[MOS] Tekmetric endpoint outage: ${actuallyInserted.length} shape(s) firing`,
            html,
          });
          emailed += 1;
        } catch (err: any) {
          console.error(
            `[TekmetricEndpointHealth] Email send failed for ${admin.email}:`,
            err?.message,
          );
        }
      }
    }
  }

  console.log(
    `[TekmetricEndpointHealth] window=${WINDOW_MINUTES}m shapes=${allShapeStats.length} firing=${firing.length} new=${actuallyInserted.length} recovered=${recovered.length} emailed=${emailed}`,
  );

  return NextResponse.json({
    windowMinutes: WINDOW_MINUTES,
    since: since.toISOString(),
    generatedAt: new Date().toISOString(),
    thresholds: {
      minSamplesPerShop: MIN_SAMPLES_PER_SHOP,
      fullyFailingShopThreshold: FULLY_FAILING_SHOP_THRESHOLD,
      globalErrorRateThreshold: GLOBAL_ERROR_RATE_THRESHOLD,
      globalMinSamples: GLOBAL_MIN_SAMPLES,
    },
    shapesScanned: allShapeStats.length,
    firing: firing.length,
    newAlerts: actuallyInserted.length,
    alreadyFiring: firing.length - actuallyInserted.length,
    recovered,
    emailed,
    firingShapes: firing.map((f) => ({
      endpointShape: f.endpointShape,
      totalRequests: f.totalRequests,
      totalErrors: f.totalErrors,
      errorRate: Number(f.errorRate.toFixed(4)),
      fullyFailingShops: f.fullyFailingShops,
      reasons: f.reasons,
      affectedShops: f.affectedShops,
    })),
  });
}
