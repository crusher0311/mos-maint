import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { sendEmail } from "@/lib/email";
import * as callbackEvents from "@/lib/data/repositories/protractor-callback-events";

/**
 * Test seam — same pattern as `app/api/cron/tekmetric-webhook-health`.
 * The route dereferences `__deps.getDb` / `__deps.sendEmail` at call time
 * so the route-level smoke test can swap in fakes without spinning up
 * Mongo or Resend. Production callers should never touch this object.
 */
export const __deps = {
  getDb,
  sendEmail,
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same defaults as the Tekmetric webhook health alerter so the two
// pipelines stay familiar — task #480 step 6. Tunable via env without
// a redeploy.
const RECEIPT_DROP_RATIO = Number(
  process.env.PROTRACTOR_WEBHOOK_RECEIPT_DROP_RATIO || 0.5,
);
const RECEIPT_DROP_MIN_7D = Number(
  process.env.PROTRACTOR_WEBHOOK_RECEIPT_DROP_MIN_7D || 14,
);
// Recovery look-back: how many UTC days before "today" to scan for open
// silent alerts whose shop is now delivering callbacks again. Bounded to
// keep the loop cheap and avoid resurrecting ancient outages as fresh
// "recovered" pages.
const RECOVERY_LOOKBACK_DAYS = 3;

// Fleet-wide processing-lag detection — July 21-22 2026 incident: webhooks
// ARRIVED fine (~48k/day) but the inline processCallbackEvent fetch silently
// wedged, so only ~3% got processed for ~23h with zero error logs. Receipt
// health alone can't see this. We compare events *received* vs events
// *processed* over a trailing window; when the processed ratio collapses
// below the threshold with meaningful volume, that's a processing wedge,
// not a webhook outage. Duplicate/superseded events keep the healthy ratio
// well below 1.0 (~0.55-0.65 observed), so the trip wire sits far under it.
const PROCESSING_LAG_WINDOW_HOURS = Number(
  process.env.PROTRACTOR_PROCESSING_LAG_WINDOW_HOURS || 2,
);
const PROCESSING_LAG_RATIO = Number(
  process.env.PROTRACTOR_PROCESSING_LAG_RATIO || 0.2,
);
const PROCESSING_LAG_MIN_RECEIVED = Number(
  process.env.PROTRACTOR_PROCESSING_LAG_MIN_RECEIVED || 100,
);

/**
 * Protractor webhook health monitor — task #480.
 *
 * For every Protractor-connected shop this cron:
 *   1. Counts `protractor_callback_events` in the last 24h. Shops with
 *      zero are flagged as silent.
 *   2. Compares each shop's 24h count against its 7d daily average; a
 *      drop below `PROTRACTOR_WEBHOOK_RECEIPT_DROP_RATIO` (default 0.5)
 *      with a 7d-volume floor is flagged as a receipt drop.
 *   3. Detects recovery: any shop with an open (unresolved) silent
 *      alert from the prior 1-3 UTC days that's now receiving callbacks
 *      again is rolled up into a "recovered" section so on-call gets a
 *      clean "all clear" instead of having to guess.
 *
 * All three roll up into ONE consolidated email per cron run sent to
 * every platform admin. Idempotent: dedup is per (shopId, alertDate,
 * alertKind) so re-running the cron the same UTC day is a no-op.
 *
 * The Tier 1 (af-log-tail) and Tier 2 (stage-refresh) fallback crons
 * deliberately do NOT factor into this signal — the whole point is to
 * detect that the upstream Protractor webhook is broken, even when the
 * fallback paths are masking the user-visible symptom.
 *
 * Auth: standard `Authorization: Bearer ${CRON_SECRET}` mirrors the
 * Tekmetric route. Kill switch: `PROTRACTOR_WEBHOOK_HEALTH_DISABLED=true`.
 *
 * Diagnostic surface for on-call: `/api/admin/sync-health/protractor`.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  const expected = process.env.CRON_SECRET
    ? `Bearer ${process.env.CRON_SECRET}`
    : "";
  if (expected && auth !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (process.env.PROTRACTOR_WEBHOOK_HEALTH_DISABLED === "true") {
    return NextResponse.json({ ok: true, disabled: true });
  }

  const db = await __deps.getDb();
  const now = Date.now();
  const since24h = new Date(now - 24 * 60 * 60 * 1000);
  const since7d = new Date(now - 7 * 24 * 60 * 60 * 1000);
  const today = new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD UTC

  // All Protractor-configured shops. Architectural note from the task:
  // shops are scoped by our internal `shops.shopId` (numeric), filterable
  // by `shops.protractor.configured: true`. There's no separate
  // Protractor-side shop id to map — `protractor_callback_events` already
  // stores callbacks keyed by our shop id (verified above in the POST/GET
  // handlers — `shopId: shop.shopId`).
  const protractorShops = await db.collection("shops").find(
    { "protractor.configured": true },
    { projection: { shopId: 1, name: 1 } },
  ).toArray();

  if (protractorShops.length === 0) {
    return NextResponse.json({
      scanned: 0,
      silent: 0,
      drops: 0,
      recovered: 0,
      emailed: 0,
      note: "no Protractor shops",
    });
  }

  const shopIds = protractorShops
    .map((s: any) => Number(s.shopId))
    .filter((n: number) => Number.isFinite(n));

  // Keep the time-window scan cheap (Mongo-mode only; PG indexes ship in
  // drizzle/0024). Repo dispatches on PROTRACTOR_OPS_PG_CANONICAL — task
  // #1006. The `db` handle is passed through so the `__deps.getDb` test
  // seam keeps working against the fake Mongo db.
  await callbackEvents.ensureHealthScanIndexes(db);

  // Per-shop event counts in the 24h + 7d windows.
  const [counts24hRows, counts7dRows] = await Promise.all([
    callbackEvents.countsByShopSince(shopIds, since24h, db),
    callbackEvents.countsByShopSince(shopIds, since7d, db),
  ]);

  const countByShop24h = new Map<number, number>();
  for (const row of counts24hRows) {
    countByShop24h.set(row.shopId, row.count);
  }
  const countByShop7d = new Map<number, number>();
  for (const row of counts7dRows) {
    countByShop7d.set(row.shopId, row.count);
  }

  type SilentRow = { shopId: number; name: string; eventsLast24h: number };
  type DropRow = {
    shopId: number;
    name: string;
    eventsLast24h: number;
    eventsLast7d: number;
    expectedDailyAverage: number;
  };
  type RecoveryRow = {
    shopId: number;
    name: string;
    eventsLast24h: number;
    silentSince: string | null;
  };

  const silent: SilentRow[] = [];
  const drops: DropRow[] = [];

  for (const shop of protractorShops as any[]) {
    const sid = Number(shop.shopId);
    if (!Number.isFinite(sid)) continue;
    const c24 = countByShop24h.get(sid) || 0;
    const c7 = countByShop7d.get(sid) || 0;
    if (c24 === 0) {
      silent.push({ shopId: sid, name: shop.name || "(unnamed)", eventsLast24h: 0 });
      continue;
    }
    if (c7 >= RECEIPT_DROP_MIN_7D) {
      const expectedDailyAvg = c7 / 7;
      if (c24 < RECEIPT_DROP_RATIO * expectedDailyAvg) {
        drops.push({
          shopId: sid,
          name: shop.name || "(unnamed)",
          eventsLast24h: c24,
          eventsLast7d: c7,
          expectedDailyAverage: Math.round(expectedDailyAvg * 10) / 10,
        });
      }
    }
  }

  // Dedup collection — unique index on (shopId, alertDate, alertKind) so
  // silent / drop / recovery for the same shop+day live in distinct rows
  // and can't suppress each other.
  const alertsCol = db.collection("protractor_webhook_health_alerts");
  await alertsCol.createIndex(
    { shopId: 1, alertDate: 1, alertKind: 1 },
    { unique: true, name: "uniq_shop_date_kind" },
  ).catch(() => {});

  // ---------- Fleet-wide processing-lag detection ----------
  // Received vs processed in the trailing window. `receivedAt` counts GET
  // callbacks landing; `processedAt` counts events whose follow-up fetch
  // actually completed (any method). A collapse in the ratio with healthy
  // receipt volume means the inline processor is wedged (see July 21-22
  // 2026 incident note at the top of this file).
  const lagWindowStart = new Date(
    now - PROCESSING_LAG_WINDOW_HOURS * 60 * 60 * 1000,
  );
  // Keep the two counts on the SAME population (method:"GET") — POST rows
  // are also stamped `processedAt` on their own path, and counting them in
  // the numerator can mask a GET-processing wedge (false negative).
  // (The method_1_receivedAt_-1 / method_1_processedAt_-1 index ensures
  // moved into callbackEvents.ensureHealthScanIndexes above.)
  const [lagReceived, lagProcessed] = await Promise.all([
    callbackEvents.countGetSince("receivedAt", lagWindowStart, db),
    callbackEvents.countGetSince("processedAt", lagWindowStart, db),
  ]);
  const lagRatio = lagReceived > 0 ? lagProcessed / lagReceived : 1;
  const processingLagTripped =
    lagReceived >= PROCESSING_LAG_MIN_RECEIVED &&
    lagRatio < PROCESSING_LAG_RATIO;

  if (processingLagTripped) {
    // [OPS-ALERT] prefix so the Better Stack pipeline-stall escalation
    // pattern picks this up even if the email path fails.
    console.error(
      `[OPS-ALERT] [ProtractorWebhookHealth] Processing wedge suspected: received ${lagReceived} GET callbacks in last ${PROCESSING_LAG_WINDOW_HOURS}h but only ${lagProcessed} events processed (ratio ${lagRatio.toFixed(2)} < ${PROCESSING_LAG_RATIO}). Webhooks are arriving; the inline processCallbackEvent path is not completing.`,
    );
  }

  // ---------- Recovery detection ----------
  // Find open silent alerts from the prior RECOVERY_LOOKBACK_DAYS UTC days
  // (excluding today) whose shop is now delivering callbacks again. For
  // each, emit a recovery row AND stamp `resolvedAt` on the original
  // silent alert so future cron runs don't re-detect the same recovery.
  const lookbackCutoff = new Date(
    now - RECOVERY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  )
    .toISOString()
    .slice(0, 10);

  const openSilentAlerts = await alertsCol.find({
    alertKind: "silent",
    alertDate: { $gte: lookbackCutoff, $lt: today },
    resolvedAt: { $exists: false },
  }).toArray();

  const recovered: RecoveryRow[] = [];
  const shopNameById = new Map<number, string>();
  for (const s of protractorShops as any[]) {
    shopNameById.set(Number(s.shopId), s.name || "(unnamed)");
  }

  for (const alert of openSilentAlerts as any[]) {
    const sid = Number(alert.shopId);
    const c24 = countByShop24h.get(sid) || 0;
    if (c24 > 0) {
      recovered.push({
        shopId: sid,
        name: shopNameById.get(sid) || `(shop ${sid})`,
        eventsLast24h: c24,
        silentSince: alert.alertDate || null,
      });
    }
  }

  // ---------- Dedup insert for silent alerts ----------
  const toAlertSilent: SilentRow[] = [];
  for (const s of silent) {
    try {
      await alertsCol.insertOne({
        shopId: s.shopId,
        alertDate: today,
        alertKind: "silent",
        eventsLast24h: s.eventsLast24h,
        createdAt: new Date(),
      });
      toAlertSilent.push(s);
    } catch (err: any) {
      if (err?.code !== 11000) {
        console.error(
          `[ProtractorWebhookHealth] Silent dedup failed for shop ${s.shopId}:`,
          err?.message,
        );
      }
    }
  }

  // ---------- Dedup insert for drop alerts ----------
  const toAlertDrop: DropRow[] = [];
  for (const d of drops) {
    try {
      await alertsCol.insertOne({
        shopId: d.shopId,
        alertDate: today,
        alertKind: "drop",
        eventsLast24h: d.eventsLast24h,
        eventsLast7d: d.eventsLast7d,
        expectedDailyAverage: d.expectedDailyAverage,
        createdAt: new Date(),
      });
      toAlertDrop.push(d);
    } catch (err: any) {
      if (err?.code !== 11000) {
        console.error(
          `[ProtractorWebhookHealth] Drop dedup failed for shop ${d.shopId}:`,
          err?.message,
        );
      }
    }
  }

  // ---------- Dedup insert for the processing-lag alert ----------
  // Fleet-wide (not per-shop) so it uses the shopId:0 sentinel. Dedup per
  // UTC day like the other kinds — the hourly cron keeps [OPS-ALERT]
  // logging every run while the wedge persists, but email fires once/day.
  let newProcessingLagAlert = false;
  if (processingLagTripped) {
    try {
      await alertsCol.insertOne({
        shopId: 0,
        alertDate: today,
        alertKind: "processing-lag",
        windowHours: PROCESSING_LAG_WINDOW_HOURS,
        received: lagReceived,
        processed: lagProcessed,
        ratio: Math.round(lagRatio * 1000) / 1000,
        createdAt: new Date(),
      });
      newProcessingLagAlert = true;
    } catch (err: any) {
      if (err?.code !== 11000) {
        console.error(
          "[ProtractorWebhookHealth] Processing-lag dedup failed:",
          err?.message,
        );
      }
    }
  }

  // ---------- Dedup insert for recovery alerts + resolve originals ----------
  const toAlertRecovered: RecoveryRow[] = [];
  for (const r of recovered) {
    try {
      await alertsCol.insertOne({
        shopId: r.shopId,
        alertDate: today,
        alertKind: "recovery",
        eventsLast24h: r.eventsLast24h,
        silentSince: r.silentSince,
        createdAt: new Date(),
      });
      toAlertRecovered.push(r);
      // Stamp `resolvedAt` on the original silent alert so it won't be
      // re-detected on the next cron tick within the lookback window.
      try {
        await alertsCol.updateOne(
          {
            shopId: r.shopId,
            alertKind: "silent",
            alertDate: r.silentSince,
          },
          { $set: { resolvedAt: new Date(), resolvedOn: today } },
        );
      } catch (err: any) {
        console.error(
          `[ProtractorWebhookHealth] Failed to stamp resolvedAt for shop ${r.shopId}:`,
          err?.message,
        );
      }
    } catch (err: any) {
      if (err?.code !== 11000) {
        console.error(
          `[ProtractorWebhookHealth] Recovery dedup failed for shop ${r.shopId}:`,
          err?.message,
        );
      }
    }
  }

  // ---------- Consolidated email ----------
  let emailed = 0;
  const anyNew =
    toAlertSilent.length > 0 ||
    toAlertDrop.length > 0 ||
    toAlertRecovered.length > 0 ||
    newProcessingLagAlert;

  if (anyNew) {
    const admins = await db.collection("users").find(
      { isPlatformAdmin: true, email: { $exists: true, $ne: null } },
      { projection: { email: 1 } },
    ).toArray();

    if (admins.length === 0) {
      console.warn(
        "[ProtractorWebhookHealth] No platform admins configured; alerts logged only",
      );
    } else {
      const sections: string[] = [];

      if (newProcessingLagAlert) {
        sections.push(`
          <h3 style="margin-top:24px;color:#b00020">Processing wedge suspected (fleet-wide)</h3>
          <p>Webhooks are <strong>arriving</strong> but the follow-up fetch is <strong>not completing</strong> — in the last ${PROCESSING_LAG_WINDOW_HOURS}h we received <strong>${lagReceived}</strong> GET callbacks and processed only <strong>${lagProcessed}</strong> events (ratio ${lagRatio.toFixed(2)}, alert threshold ${PROCESSING_LAG_RATIO}). Healthy ratio runs ~0.55&ndash;0.65 due to duplicate callbacks.</p>
          <p>This is the July 21&ndash;22 2026 failure mode: events sit at <code>processed:false, attempts:0</code> with no error logs because the request wedges inside the Protractor client's background concurrency pool. Shop data goes stale fleet-wide even though webhook receipt looks green. Un-stick by replaying stuck WorkOrder ids through <code>GET /api/callbacks/protractor?connectionId=&hellip;&amp;type=WorkOrder&amp;id=&hellip;&amp;operation=Update</code>.</p>`);
      }

      if (toAlertSilent.length > 0) {
        const rows = toAlertSilent.map((s) => `
          <tr>
            <td style="padding:6px 12px;border:1px solid #ddd">${s.name}</td>
            <td style="padding:6px 12px;border:1px solid #ddd">${s.shopId}</td>
          </tr>`).join("");
        sections.push(`
          <h3 style="margin-top:24px">Silent shops (zero callbacks in last 24h) — ${toAlertSilent.length}</h3>
          <p>Likely causes: Protractor webhook subscription dropped on their side, transport-layer issue, or shop disconnected. Tier 1 (af-log-tail) and Tier 2 (stage-refresh) fallbacks may still be masking the user-visible symptom — this alert says the upstream <em>webhook</em> is the problem.</p>
          <table style="border-collapse:collapse;border:1px solid #ddd">
            <thead>
              <tr>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Shop</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">MOS Shop ID</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>`);
      }

      if (toAlertDrop.length > 0) {
        const rows = toAlertDrop.map((d) => `
          <tr>
            <td style="padding:6px 12px;border:1px solid #ddd">${d.name}</td>
            <td style="padding:6px 12px;border:1px solid #ddd">${d.shopId}</td>
            <td style="padding:6px 12px;border:1px solid #ddd">${d.eventsLast24h}</td>
            <td style="padding:6px 12px;border:1px solid #ddd">${d.expectedDailyAverage}</td>
          </tr>`).join("");
        sections.push(`
          <h3 style="margin-top:24px">Receipt-rate drop (&lt; ${Math.round(RECEIPT_DROP_RATIO * 100)}% of trailing 7d daily average) — ${toAlertDrop.length}</h3>
          <p>These shops are still delivering some callbacks but at materially lower volume than their own recent baseline.</p>
          <table style="border-collapse:collapse;border:1px solid #ddd">
            <thead>
              <tr>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Shop</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">MOS Shop ID</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Last 24h</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Expected (7d avg)</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>`);
      }

      if (toAlertRecovered.length > 0) {
        const rows = toAlertRecovered.map((r) => `
          <tr>
            <td style="padding:6px 12px;border:1px solid #ddd">${r.name}</td>
            <td style="padding:6px 12px;border:1px solid #ddd">${r.shopId}</td>
            <td style="padding:6px 12px;border:1px solid #ddd">${r.silentSince || "—"}</td>
            <td style="padding:6px 12px;border:1px solid #ddd">${r.eventsLast24h}</td>
          </tr>`).join("");
        sections.push(`
          <h3 style="margin-top:24px">Recovered (callbacks resumed) — ${toAlertRecovered.length}</h3>
          <p>Previously-silent shops now delivering callbacks again. The original silent alert has been marked resolved.</p>
          <table style="border-collapse:collapse;border:1px solid #ddd">
            <thead>
              <tr>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Shop</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">MOS Shop ID</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Silent since</th>
                <th style="padding:6px 12px;border:1px solid #ddd;text-align:left">Last 24h</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>`);
      }

      const html = `
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5">
          <h2>Protractor Webhook Health</h2>
          ${sections.join("\n")}
          <p style="margin-top:16px;color:#666;font-size:13px">
            Sent by <code>/api/cron/protractor-webhook-health</code> · Diagnostic surface:
            <code>/api/admin/sync-health/protractor</code>
          </p>
        </div>`;

      const subjectParts: string[] = [];
      if (newProcessingLagAlert) subjectParts.push("PROCESSING WEDGE");
      if (toAlertSilent.length > 0) subjectParts.push(`${toAlertSilent.length} silent`);
      if (toAlertDrop.length > 0) subjectParts.push(`${toAlertDrop.length} drop`);
      if (toAlertRecovered.length > 0) subjectParts.push(`${toAlertRecovered.length} recovered`);
      const subject = `[MOS] Protractor webhook health: ${subjectParts.join(", ")}`;

      for (const admin of admins as unknown as Array<{ email: string }>) {
        try {
          await __deps.sendEmail({
            to: admin.email,
            subject,
            html,
          });
          emailed++;
        } catch (err: any) {
          console.error(
            `[ProtractorWebhookHealth] Email send failed for ${admin.email}:`,
            err?.message,
          );
        }
      }
    }
  }

  console.log(
    `[ProtractorWebhookHealth] Scanned ${protractorShops.length} shops, ${silent.length} silent (${toAlertSilent.length} new), ${drops.length} drop (${toAlertDrop.length} new), ${recovered.length} recovered (${toAlertRecovered.length} new), processing ${lagProcessed}/${lagReceived} last ${PROCESSING_LAG_WINDOW_HOURS}h (ratio ${lagRatio.toFixed(2)}${processingLagTripped ? ", TRIPPED" : ""}), emailed ${emailed} admin(s)`,
  );

  return NextResponse.json({
    scanned: protractorShops.length,
    silent: silent.length,
    drops: drops.length,
    recovered: recovered.length,
    processingLag: {
      windowHours: PROCESSING_LAG_WINDOW_HOURS,
      received: lagReceived,
      processed: lagProcessed,
      ratio: Math.round(lagRatio * 1000) / 1000,
      tripped: processingLagTripped,
      newAlert: newProcessingLagAlert,
    },
    newSilentAlerts: toAlertSilent.length,
    newDropAlerts: toAlertDrop.length,
    newRecoveryAlerts: toAlertRecovered.length,
    alreadyAlertedToday:
      silent.length - toAlertSilent.length +
      (drops.length - toAlertDrop.length) +
      (recovered.length - toAlertRecovered.length),
    emailed,
    silentShops: silent,
    receiptDrops: drops,
    recoveredShops: recovered,
  });
}
