/**
 * Protractor Stage Refresh Cron — Tier 2 webhook-outage fallback
 * ================================================================
 *
 * BACKGROUND (2026-05-15 outage):
 *   Protractor stopped delivering webhooks to /api/callbacks/protractor
 *   system-wide on 2026-05-15 00:42 UTC. Their worker is healthy
 *   (AppFueled's public request log confirms it — see Tier 1 cron at
 *   `protractor-af-log-tail`), but delivery to OUR endpoint is broken
 *   destination-side. Darren's ticket with Protractor dev is open.
 *
 *   Tier 1 (`protractor-af-log-tail`) covers the ~10 shops we share
 *   with AppFueled at ~60s freshness by tailing AF's log. This Tier 2
 *   handler covers the remaining ~17 Protractor shops by polling each
 *   shop's active work-order list every 3 min and synthesizing callback
 *   replays for state changes.
 *
 *   AF-shared shops are EXCLUDED by default (see EXCLUDE_SHOPS below):
 *   the /api/callbacks/protractor GET de-dup window is only 60s AND
 *   keyed on `operation`, and Tier 1 emits the actual AF-parsed
 *   operation (`Update` / `Delete` / `Invoiced` / …) while Tier 2 always
 *   emits `UPDATE`. Different keys → no de-dup → each transition on an
 *   AF-shared shop would be processed twice and double-bill the
 *   Protractor API. Cleaner to let Tier 1 own those shops.
 *
 * DIFFERENCE FROM `protractor-sync` (the heavy 30-min cron):
 *   - protractor-sync fetches active list + per-WO detail + ingests +
 *     pregenerates plans. Too heavy for a 2-min envelope (27 shops ×
 *     pLimit(4) × per-WO detail fetches + normalized ingestion +
 *     post-sync pregeneration loop blew through the 4-min limit on the
 *     first Tier 2 attempt).
 *   - THIS handler does ONE call per shop: `fetchActiveWorkOrders`
 *     (the list endpoint, paginated). No per-WO detail fetches. No
 *     ingestion. No pregeneration. Diff current active set against
 *     last-tick snapshot, synthesize callback replays for transitions,
 *     persist new snapshot. That's it.
 *
 *   The downstream `/api/callbacks/protractor` handler does the heavy
 *   per-WO work asynchronously in its existing background-enrich path,
 *   exactly the same way it would for a real webhook.
 *
 * TRANSITIONS WE FIRE ON:
 *   (a) WO disappeared from active list (was in last snapshot, not in
 *       current) → invoiced/closed/voided/deleted in Protractor.
 *       Synthesize UPDATE; callback handler fetches detail and sees
 *       the terminal state.
 *   (b) WO's WorkflowStage now contains an INVOICED_STAGES keyword
 *       (still in active list — Protractor sometimes keeps invoiced
 *       WOs on the active list briefly).
 *   (c) WO is NEW (in current snapshot, not in last) → newly opened
 *       RO that the webhook would have delivered.
 *
 *   We deliberately do NOT fire on intermediate stage changes
 *   (Estimate → In Progress) — those don't affect the dashboard's
 *   active-RO list and aren't worth the Protractor API budget.
 *
 * COLD START:
 *   First tick for a shop has no snapshot. We persist the current
 *   active set without firing ANY replays (otherwise we'd fire (c)
 *   for every currently-active WO, ~50/shop × 17 shops = ~850 spurious
 *   replays). Subsequent ticks diff against the persisted snapshot.
 *
 * KILL SWITCH:
 *   `PROTRACTOR_STAGE_REFRESH_DISABLED=true` makes the handler a no-op
 *   that returns `{ ok: true, disabled: true }`. Use if this cron
 *   starts causing problems (rate-limit pressure, false-positive
 *   transitions, etc.) without redeploying. The Tier 1 af-log-tail
 *   stays active for the AF-shared shops either way.
 *
 * REMOVAL CRITERIA:
 *   When real Protractor webhook delivery resumes (look for
 *   non-cron-source rows in `protractor_callback_events` over the last
 *   hour), delete this route file and the cron entry in
 *   `lib/cron/jobs.cjs`.
 *
 * RATE BUDGET:
 *   27 shops × 1 list call/tick = ~27 calls / 120s = ~0.23 RPS.
 *   Well under the 5-RPS Protractor cap. Replay GETs to our own
 *   callback handler are cheap (Mongo insert + early ack); the
 *   downstream per-WO fetches are already rate-limited by
 *   `lib/integrations/protractor/client.ts`.
 */
import { NextRequest, NextResponse } from "next/server";
import { getProtractorOutboundPolicy } from "@/lib/integrations/protractor/client";
import { logProtractorPolicyDenial } from "@/lib/integrations/protractor/outbound-policy.cjs";
import { getDb } from "@/lib/mongo";
import { fetchActiveWorkOrders, resolveProtractorConfig } from "@/lib/integrations/protractor";
import pLimit from "p-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CRON_SECRET = process.env.CRON_SECRET;
const STATE_COLLECTION = "protractor_stage_refresh_state";
// 8-way shop concurrency is safe: each Protractor shop has its own API
// credentials, so the 5-RPS per-key cap is independent per shop. The
// shared limit is on credentials, not on us. First smoke test at pLimit(4)
// ran ~125s end-to-end (Protractor's list endpoint is ~4-5s per 100-WO
// page); doubling to 8 brings tick runtime well under the 3-min cadence.
const SHOP_CONCURRENCY = 8;
const MAX_REPLAYS_PER_SHOP_PER_TICK = 100;

// AF-shared shops — Tier 1 (`protractor-af-log-tail`) already covers these
// at ~60s freshness via AppFueled's request log. We skip them here to
// avoid duplicate Protractor API calls (see route-header docblock for the
// dedup-key mismatch that makes overlap actually double the work).
// Override at runtime with comma-separated env var if Tier 1's coverage
// changes. Default list captured from the session-15 incident notes.
const DEFAULT_EXCLUDE_SHOPS = [25, 29, 50, 51, 67, 68, 69, 70, 71, 72];
function getExcludeShops(): Set<number> {
  const raw = process.env.PROTRACTOR_STAGE_REFRESH_EXCLUDE_SHOPS;
  if (!raw) return new Set(DEFAULT_EXCLUDE_SHOPS);
  const ids = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
  return new Set(ids);
}

// Exact-match terminal stage strings observed in Protractor's WorkflowStage
// enum (mirrors INVOICED_STAGES in `app/api/cron/protractor-sync/route.ts`).
// Compared after case-folding the incoming stage. Code-review caught that
// the prior `includes("complete")` substring matcher would false-positive
// on any stage containing "incomplete" or similar, firing phantom replays
// and burning Protractor rate budget.
const TERMINAL_STAGES = new Set([
  "invoiced",
  "invoice",
  "void",
  "closed",
  "complete",
  "completed",
]);

type WoSnapshot = { stage: string };

type ShopResult = {
  shopId: number;
  ok: boolean;
  coldStart?: boolean;
  activeCount?: number;
  transitions?: { disappeared: number; invoiced: number; newWos: number };
  replayed?: number;
  replayFailed?: number;
  capped?: boolean;
  error?: string;
};

function stageIsInvoiced(stage: string | undefined | null): boolean {
  if (!stage) return false;
  return TERMINAL_STAGES.has(stage.trim().toLowerCase());
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const outboundPolicy = getProtractorOutboundPolicy();
  if (!outboundPolicy.allowed) {
    logProtractorPolicyDenial(outboundPolicy, "cron_protractor_stage_refresh");
    return NextResponse.json({ ok: true, skipped: "local_instance_policy" });
  }

  if (process.env.PROTRACTOR_STAGE_REFRESH_DISABLED === "true") {
    return NextResponse.json({ ok: true, disabled: true });
  }

  const startedAt = Date.now();
  const db = await getDb();
  const excludeShops = getExcludeShops();

  const allShops = await db
    .collection("shops")
    .find({
      $or: [
        { "protractor.apiKey": { $exists: true, $nin: [null, ""] } },
        { protractorApiKey: { $exists: true, $nin: [null, ""] } },
        { "protractor.connectionId": { $exists: true, $nin: [null, ""] } },
        { protractorConnectionId: { $exists: true, $nin: [null, ""] } },
      ],
    })
    .project({ _id: 0, shopId: 1 })
    .toArray();

  const shops = allShops.filter(
    (s) => !excludeShops.has(Number((s as any).shopId)),
  );
  const skippedShopIds = allShops
    .map((s) => Number((s as any).shopId))
    .filter((id) => excludeShops.has(id));

  const baseUrl = req.nextUrl.origin;
  const results: ShopResult[] = [];
  const shopLimit = pLimit(SHOP_CONCURRENCY);

  await Promise.all(
    shops.map((s) =>
      shopLimit(async () => {
        const shopId = Number((s as any).shopId);
        if (!Number.isFinite(shopId)) return;
        const r = await refreshShop(db, baseUrl, shopId);
        results.push(r);
      }),
    ),
  );

  const totals = results.reduce(
    (acc, r) => {
      if (r.error) acc.errors++;
      if (r.coldStart) acc.coldStarts++;
      acc.replayed += r.replayed || 0;
      acc.replayFailed += r.replayFailed || 0;
      acc.transitions.disappeared += r.transitions?.disappeared || 0;
      acc.transitions.invoiced += r.transitions?.invoiced || 0;
      acc.transitions.newWos += r.transitions?.newWos || 0;
      return acc;
    },
    {
      errors: 0,
      coldStarts: 0,
      replayed: 0,
      replayFailed: 0,
      transitions: { disappeared: 0, invoiced: 0, newWos: 0 },
    },
  );

  const duration = Date.now() - startedAt;
  console.log(
    `[Cron] protractor-stage-refresh: shops=${results.length} replayed=${totals.replayed} failed=${totals.replayFailed} coldStarts=${totals.coldStarts} errors=${totals.errors} (${duration}ms)`,
  );

  return NextResponse.json({
    ok: true,
    durationMs: duration,
    shops: results.length,
    skipped: skippedShopIds,
    totals,
    shopResults: results,
  });
}

async function refreshShop(
  db: any,
  baseUrl: string,
  shopId: number,
): Promise<ShopResult> {
  try {
    const config = await resolveProtractorConfig(shopId);
    if (!config.configured) {
      return { shopId, ok: false, error: "not configured" };
    }

    const active = await fetchActiveWorkOrders(shopId, { readInProgress: true });
    if (!active.ok || !active.workOrders) {
      return { shopId, ok: false, error: active.error || "fetch failed" };
    }

    // Build current snapshot map from the list response. Guard against a
    // nullish ID becoming the literal string "undefined"/"null" (which is
    // truthy and would pollute the snapshot with a fake WO that re-fires
    // as a phantom transition every tick) — caught in 2nd code review.
    const currentMap: Record<string, WoSnapshot> = {};
    for (const wo of active.workOrders) {
      if (wo.ID == null) continue;
      const id = String(wo.ID).trim();
      if (!id) continue;
      currentMap[id] = { stage: wo.WorkflowStage || (wo as any).Status || "" };
    }

    // Load previous snapshot for this shop.
    const stateDoc = await db
      .collection(STATE_COLLECTION)
      .findOne({ _id: shopId as any });

    // Cold start: persist snapshot, fire no replays.
    if (!stateDoc) {
      await db.collection(STATE_COLLECTION).updateOne(
        { _id: shopId as any },
        {
          $set: {
            shopId,
            activeWos: currentMap,
            updatedAt: new Date(),
            lastTickStats: { coldStart: true, activeCount: Object.keys(currentMap).length },
          },
          $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true },
      );
      return {
        shopId,
        ok: true,
        coldStart: true,
        activeCount: Object.keys(currentMap).length,
        transitions: { disappeared: 0, invoiced: 0, newWos: 0 },
        replayed: 0,
        replayFailed: 0,
      };
    }

    const previousMap: Record<string, WoSnapshot> = (stateDoc as any).activeWos || {};

    // Diff: detect transitions.
    const disappearedIds: string[] = [];
    const invoicedIds: string[] = [];
    const newIds: string[] = [];

    for (const id of Object.keys(previousMap)) {
      if (!currentMap[id]) disappearedIds.push(id);
    }
    for (const id of Object.keys(currentMap)) {
      if (!previousMap[id]) {
        newIds.push(id);
      } else {
        // Same WO present in both — fire on transition INTO invoiced state.
        const wasInvoiced = stageIsInvoiced(previousMap[id].stage);
        const nowInvoiced = stageIsInvoiced(currentMap[id].stage);
        if (!wasInvoiced && nowInvoiced) invoicedIds.push(id);
      }
    }

    // Build replay set, cap to avoid runaway dispatch on a bad snapshot.
    // Order matters: disappeared first (dashboard-cleanup, most user-visible),
    // then invoiced (state correction on still-listed WOs), then new (least
    // urgent — a new WO that's missed this tick will be detected next tick
    // anyway because we preserve unprocessed transitions in the snapshot).
    const allReplayIds = [...disappearedIds, ...invoicedIds, ...newIds];
    const capped = allReplayIds.length > MAX_REPLAYS_PER_SHOP_PER_TICK;
    const replayIds = capped
      ? allReplayIds.slice(0, MAX_REPLAYS_PER_SHOP_PER_TICK)
      : allReplayIds;
    const dispatchedSet = new Set(replayIds);
    // Carry forward IDs we deliberately did NOT dispatch so the next tick
    // re-detects them. Code review caught the original bug: snapshot was
    // unconditionally advanced to `currentMap`, which permanently dropped
    // any transition beyond the per-shop cap.
    const skippedDueToCap = allReplayIds.filter((id) => !dispatchedSet.has(id));

    // Replay each transition through our own callback handler. Operation is
    // UPDATE in every case — the callback handler always re-fetches the
    // current state from Protractor, so the same handler path works for
    // disappeared (now invoiced), invoiced-in-list, and new-open WOs.
    let replayed = 0;
    let replayFailed = 0;
    const replayLimit = pLimit(3); // per-shop concurrency for the callback POSTs
    await Promise.all(
      replayIds.map((woId) =>
        replayLimit(async () => {
          const params = new URLSearchParams({
            connectionId: config.connectionId,
            apiKey: config.apiKey,
            type: "WorkOrder",
            id: woId,
            operation: "UPDATE",
          });
          const url = `${baseUrl}/api/callbacks/protractor?${params.toString()}`;
          try {
            const r = await fetch(url, {
              method: "GET",
              cache: "no-store",
              headers: { "user-agent": "mos-tools/stage-refresh" },
            });
            if (r.ok) replayed++;
            else replayFailed++;
          } catch {
            replayFailed++;
          }
        }),
      ),
    );

    // Persist next snapshot. Start from the freshly observed currentMap,
    // then "rewind" any transition we did NOT dispatch this tick (cap
    // overflow) so the next tick re-detects it:
    //   - disappeared but skipped → re-insert previous entry (still missing
    //     from currentMap next tick → still detected as disappeared)
    //   - new but skipped → delete from snapshot (still missing from
    //     previous → still detected as new)
    //   - invoiced but skipped → restore the previous (non-terminal) stage
    //     so the transition-into-invoiced fires again
    //
    // Failed-dispatch transitions (replayFailed) are NOT rewound — they
    // were dispatched and we don't know if /api/callbacks/protractor's
    // background-enrich actually failed too or just the synchronous ack
    // path. Re-firing them next tick would double-process if enrich
    // succeeded. Acceptable trade-off; the daily protractor-sync catches
    // anything that slipped through.
    const nextSnapshot: Record<string, WoSnapshot> = { ...currentMap };
    for (const id of skippedDueToCap) {
      if (!currentMap[id] && previousMap[id]) {
        nextSnapshot[id] = previousMap[id]; // skipped disappeared
      } else if (currentMap[id] && !previousMap[id]) {
        delete nextSnapshot[id]; // skipped new
      } else if (currentMap[id] && previousMap[id]) {
        nextSnapshot[id] = previousMap[id]; // skipped invoiced — keep old stage
      }
    }

    await db.collection(STATE_COLLECTION).updateOne(
      { _id: shopId as any },
      {
        $set: {
          shopId,
          activeWos: nextSnapshot,
          updatedAt: new Date(),
          lastTickStats: {
            activeCount: Object.keys(currentMap).length,
            disappeared: disappearedIds.length,
            invoiced: invoicedIds.length,
            newWos: newIds.length,
            replayed,
            replayFailed,
            capped,
            skippedDueToCap: skippedDueToCap.length,
          },
        },
      },
    );

    return {
      shopId,
      ok: true,
      activeCount: Object.keys(currentMap).length,
      transitions: {
        disappeared: disappearedIds.length,
        invoiced: invoicedIds.length,
        newWos: newIds.length,
      },
      replayed,
      replayFailed,
      capped,
    };
  } catch (e: any) {
    return { shopId, ok: false, error: e?.message || String(e) };
  }
}
