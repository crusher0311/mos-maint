/**
 * Protractor AppFueled-Log-Tail Cron (Tier 1 webhook-outage fallback)
 *
 * BACKGROUND
 * ----------
 * On 2026-05-15 00:42 UTC, Protractor's webhook delivery to our callback
 * endpoint stopped firing for every shop we have on Protractor (Darren's
 * dev team is investigating). Cross-referencing AppFueled's public
 * Protractor request log (https://cron.instantautosite.org/autosoftware_cron/
 * primary/protractor/request_log.txt) proved Protractor's worker IS healthy
 * and IS firing for our shops — just to AppFueled's endpoint, not ours. We
 * share ~10 customers with AF; for those shops AF's log gives us a near-
 * real-time signal of every WorkOrder change Protractor would otherwise
 * have notified us about.
 *
 * WHAT THIS CRON DOES
 * -------------------
 * 1. Fetches AF's public log.
 * 2. Parses out (timestamp, connectionId, type, objectId, operation) events,
 *    skipping PRE CHECK probes — see lib/integrations/protractor/af-log-parser.ts.
 * 3. Filters to events newer than our per-cron high-water mark (stored in
 *    `protractor_af_log_tail_state`) so we don't re-process the entire 3.5MB
 *    file each tick.
 * 4. Resolves each event's connectionId against the (connectionId → shopId)
 *    map we built up historically in `protractor_callback_events`. Events
 *    whose connectionId doesn't match a known shop are skipped (they belong
 *    to AF-only customers).
 * 5. For each resolved event, calls our own /api/callbacks/protractor GET
 *    handler in-process — same code path Protractor would have hit. That
 *    handler already does:
 *      - dedup-resilient insert into protractor_callback_events
 *      - fetch of the changed WO / vehicle from Protractor
 *      - upsert into protractor_work_orders / vehicles
 *      - dashboard refresh signal
 *      - invoiced/deleted state transitions
 *    The 200/ignored fallback for unknown connectionIds (commit f6fe7dd)
 *    protects us if a CID slips through that isn't actually ours.
 * 6. Advances the high-water mark only after a successful pass so a partial
 *    failure replays cleanly next tick.
 *
 * COST PROFILE
 * ------------
 * The Protractor API calls this cron triggers (one detail fetch per changed
 * WO) are the EXACT SAME calls a real webhook would have triggered — we're
 * not adding load to Protractor, we're just learning what changed from a
 * different source. The only new external dep is the ~3.5MB GET to AF every
 * 30s.
 *
 * REMOVAL CRITERIA
 * ----------------
 * When Protractor confirms real webhook delivery to our endpoint has
 * resumed (check `protractor_callback_events` for non-cron-source rows in
 * the last hour), this cron can be deleted. Until then it stays as the
 * primary signal for the ~10 AF-shared shops.
 */
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { parseAfLog, type AfLogEvent } from "@/lib/integrations/protractor/af-log-parser";
import * as callbackEvents from "@/lib/data/repositories/protractor-callback-events";

const CRON_SECRET = process.env.CRON_SECRET;
const AF_LOG_URL =
  process.env.PROTRACTOR_AF_LOG_URL ||
  "https://cron.instantautosite.org/autosoftware_cron/primary/protractor/request_log.txt";
const STATE_COLLECTION = "protractor_af_log_tail_state";
const STATE_DOC_ID = "singleton";
// Hard cap on how many events one tick will dispatch. Protects against
// the (unlikely) case where the high-water mark gets reset and we'd
// otherwise try to re-fire thousands of in-process callbacks in one go.
const MAX_EVENTS_PER_TICK = 200;
// On first run there is no high-water mark. Don't reach back further than
// this — older events have either already been fetched by the cron's own
// full sync or are too stale to matter for dashboard freshness.
const COLD_START_LOOKBACK_MIN = 10;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (CRON_SECRET && authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (process.env.PROTRACTOR_AF_LOG_TAIL_ENABLED === "false") {
    return NextResponse.json({ ok: true, skipped: "disabled by PROTRACTOR_AF_LOG_TAIL_ENABLED=false" });
  }

  const startedAt = Date.now();
  const db = await getDb();

  // Step 1: fetch the AF log.
  let body: string;
  try {
    const res = await fetch(AF_LOG_URL, {
      cache: "no-store",
      headers: { "user-agent": "mos-tools/af-log-tail" },
    });
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: `AF log fetch failed: ${res.status}` },
        { status: 502 },
      );
    }
    body = await res.text();
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: `AF log fetch threw: ${e?.message || e}` },
      { status: 502 },
    );
  }

  // Step 2: parse.
  const allEvents = parseAfLog(body);

  // Step 3: load high-water mark and connectionId → shopId map.
  const [stateDoc, cidRows] = await Promise.all([
    db.collection(STATE_COLLECTION).findOne({ _id: STATE_DOC_ID as any }),
    // Repo dispatches on PROTRACTOR_OPS_PG_CANONICAL (task #1006); the
    // Mongo path runs the same $group aggregate as before.
    callbackEvents.connectionShopPairs(),
  ]);

  // Sort rows by `last` descending so the first-encountered row per CID is
  // the most-recently-seen mapping. (The repo doesn't guarantee order;
  // without this the "ambiguous CID" tiebreak below would be
  // nondeterministic.)
  cidRows.sort((a, b) => {
    const al = a.last ? new Date(a.last).getTime() : 0;
    const bl = b.last ? new Date(b.last).getTime() : 0;
    return bl - al;
  });
  const cidToShopId = new Map<string, number>();
  for (const row of cidRows) {
    // If multiple shops share a CID in history (shouldn't, but observed
    // once for cid 177cef5...), keep the most-recently-seen mapping.
    if (!cidToShopId.has(row.connectionId)) cidToShopId.set(row.connectionId, row.shopId);
  }

  // Resolve high-water mark, planting a durable cold-start anchor on first
  // run so subsequent ticks don't keep recomputing a sliding "now - lookback"
  // window (which can leave the anchor unwritten forever if no log entries
  // ever land within the lookback, masking real failures and re-scanning
  // the full 3.5 MB log every tick).
  //
  // The anchor is (highWaterMark: Date, highWaterObjectId?: string). Date
  // alone is insufficient because AF log timestamps are second-precision and
  // multiple events frequently share a second; without an objectId tiebreak,
  // a partial-failure tick that anchors at the last successful event would
  // permanently skip any failed event sharing that exact second. The
  // objectId pin lets us replay everything that came AFTER the anchor's
  // objectId within the same second.
  let highWaterMs: number;
  let highWaterObjectId: string | null = null;
  if ((stateDoc as any)?.highWaterMark) {
    highWaterMs = new Date((stateDoc as any).highWaterMark).getTime();
    highWaterObjectId = (stateDoc as any).highWaterObjectId || null;
  } else {
    highWaterMs = Date.now() - COLD_START_LOOKBACK_MIN * 60 * 1000;
    try {
      await db.collection(STATE_COLLECTION).insertOne({
        _id: STATE_DOC_ID as any,
        highWaterMark: new Date(highWaterMs),
        createdAt: new Date(),
        note: `cold-start anchor (lookback=${COLD_START_LOOKBACK_MIN}min)`,
      } as any);
    } catch (e: any) {
      // Race-loss with a concurrent first boot: re-read the doc the winner
      // planted and use IT as our anchor instead of our locally-computed
      // (slightly later) `Date.now() - lookback`. Without this re-read the
      // loser would proceed with a narrower window and could skip events
      // between winner-anchor and loser-anchor.
      if (e?.code === 11000) {
        const winner = await db
          .collection(STATE_COLLECTION)
          .findOne({ _id: STATE_DOC_ID as any });
        if ((winner as any)?.highWaterMark) {
          highWaterMs = new Date((winner as any).highWaterMark).getTime();
          highWaterObjectId = (winner as any).highWaterObjectId || null;
        }
      } else {
        console.warn(`[Cron] protractor-af-log-tail: cold-start insert failed: ${e?.message || e}`);
      }
    }
  }

  // Step 4: filter to new + known-shop events, cap.
  //
  // Filter rule: an event is "new" if either:
  //   (a) its timestamp is strictly after the anchor's timestamp, OR
  //   (b) the anchor has an objectId pin, the event's timestamp equals the
  //       anchor's timestamp, AND the event appears AFTER the anchor's
  //       objectId in chronological (file) order.
  //
  // Null-pin contract (cold-start anchor; no objectId stored): treat
  // boundary-second events as already-seen — strictly accept t > ts. This
  // avoids reprocessing the exact-second boundary on first cold-start tick
  // (those events would have been delivered by the real webhook just before
  // the outage window, or by the now-10min lookback already covers them).
  const newEvents: AfLogEvent[] = [];
  let passedAnchor = false;
  for (const ev of allEvents) {
    const t = ev.timestamp.getTime();
    if (t < highWaterMs) continue;
    if (t === highWaterMs) {
      if (highWaterObjectId == null) continue; // null pin: skip all boundary-second events
      if (!passedAnchor) {
        if (ev.objectId === highWaterObjectId) passedAnchor = true;
        continue; // skip the anchor row itself and everything at or before it
      }
      // already passed the anchor — accept later events sharing the same second
    }
    if (!cidToShopId.has(ev.connectionId)) continue;
    newEvents.push(ev);
  }
  const dispatchEvents = newEvents.slice(0, MAX_EVENTS_PER_TICK);
  const capped = newEvents.length > MAX_EVENTS_PER_TICK;

  // Step 5: dispatch each event through our own callback handler.
  // Track per-event success so we can advance the high-water mark only
  // through the longest contiguous-success prefix — any failure stops the
  // advance there, guaranteeing the failed event (and everything after it)
  // gets retried on the next tick. Within the prefix, dispatchEvents is
  // already in chronological order because parseAfLog preserves file order
  // and the file is append-only chronological.
  const baseUrl = req.nextUrl.origin;
  const dispatchOk: boolean[] = new Array(dispatchEvents.length).fill(false);
  let dispatched = 0;
  let failed = 0;
  const failures: Array<{ cid: string; objectId: string; status: number; body?: string }> = [];

  for (let i = 0; i < dispatchEvents.length; i++) {
    const ev = dispatchEvents[i];
    const params = new URLSearchParams({
      connectionId: ev.connectionId,
      apiKey: ev.apiKey,
      type: ev.type,
      id: ev.objectId,
      operation: ev.operation,
    });
    const url = `${baseUrl}/api/callbacks/protractor?${params.toString()}`;
    try {
      const r = await fetch(url, {
        method: "GET",
        cache: "no-store",
        headers: { "user-agent": "mos-tools/af-log-tail" },
      });
      if (r.ok) {
        dispatched++;
        dispatchOk[i] = true;
      } else {
        failed++;
        if (failures.length < 5) {
          failures.push({
            cid: ev.connectionId,
            objectId: ev.objectId,
            status: r.status,
            body: (await r.text()).slice(0, 200),
          });
        }
      }
    } catch (e: any) {
      failed++;
      if (failures.length < 5) {
        failures.push({ cid: ev.connectionId, objectId: ev.objectId, status: 0, body: String(e?.message || e) });
      }
    }
  }

  // Step 6: advance high-water mark.
  //
  // - If any dispatch failed: advance only through the longest contiguous
  //   success prefix. The first failure is the new replay anchor; it (and
  //   everything after it, including later successes that may have raced
  //   ahead) get re-dispatched next tick. This is safe because every
  //   downstream operation in /api/callbacks/protractor is idempotent at
  //   the data layer (WO fetch + upsert).
  // - If all dispatches succeeded AND nothing was capped: advance to the
  //   newest event in the file so un-mapped CIDs (other vendors' shops)
  //   don't get re-scanned forever.
  // - If everything succeeded but we capped: advance to the last
  //   successfully dispatched event only; the next tick picks up the rest.
  //
  // Write uses optimistic compare-and-set against the (oldTs, oldOid)
  // we observed at the start of this tick. If the doc still reflects
  // that anchor (or is older / absent), we win and atomically advance
  // both fields together. If an overlapping run already advanced past
  // our observed anchor, matchedCount=0 and we silently no-op — their
  // advance is correct and we don't regress it.
  //
  // This is more precise than a timestamp-only $max guard: it allows
  // same-second advancement when only the objectId changes (the new
  // composite-anchor case), which is exactly what bursty same-second
  // batches need to make progress.
  let advanceTo: Date | null = null;
  let advanceObjectId: string | null = null;
  if (dispatchEvents.length === 0) {
    // No dispatches attempted — safe to advance past everything seen so we
    // don't re-scan unmatched CIDs every tick. The anchor objectId is the
    // last event in the file at that timestamp so any future event sharing
    // that second is still captured (file order = chronological).
    if (allEvents.length) {
      const last = allEvents[allEvents.length - 1];
      advanceTo = last.timestamp;
      advanceObjectId = last.objectId;
    }
  } else {
    // Find longest contiguous-success prefix length.
    let prefixLen = 0;
    while (prefixLen < dispatchOk.length && dispatchOk[prefixLen]) prefixLen++;

    if (prefixLen === dispatchEvents.length && !capped) {
      // Everything succeeded and we processed the full new-event set.
      if (allEvents.length) {
        const last = allEvents[allEvents.length - 1];
        advanceTo = last.timestamp;
        advanceObjectId = last.objectId;
      }
    } else if (prefixLen > 0) {
      // Partial or capped: anchor at last successful event in the prefix.
      const last = dispatchEvents[prefixLen - 1];
      advanceTo = last.timestamp;
      advanceObjectId = last.objectId;
    }
    // prefixLen === 0 (first dispatch failed) → leave advanceTo null;
    // high-water mark stays where it is so the next tick re-tries from the
    // exact same anchor.
  }

  // Decide whether our advance is a real move forward relative to what we
  // observed at start-of-tick. Two cases count as forward:
  //   - newTs > oldTs (strictly later second), OR
  //   - newTs === oldTs AND newOid !== oldOid (same second, later objectId
  //     in chronological file order — guaranteed because the filter only
  //     produced events at this second that came AFTER the anchor objectId)
  const isAdvance =
    !!advanceTo &&
    (advanceTo.getTime() > highWaterMs ||
      (advanceTo.getTime() === highWaterMs && advanceObjectId !== highWaterObjectId));

  if (isAdvance && advanceTo) {
    const newTs = advanceTo;
    const newOid = advanceObjectId;
    const oldTs = (stateDoc as any)?.highWaterMark
      ? new Date((stateDoc as any).highWaterMark)
      : null;
    const oldOid = (stateDoc as any)?.highWaterObjectId ?? null;
    const tickStats = {
      totalParsed: allEvents.length,
      newEvents: newEvents.length,
      dispatched,
      failed,
      capped,
      durationMs: Date.now() - startedAt,
    };

    // CAS filter: only match if the doc is still at the (oldTs, oldOid) we
    // observed at start of tick, OR is even older (overlapping run still
    // running), OR doesn't exist yet (upsert path). If a faster overlapping
    // run already advanced past us, the filter misses and we silently skip
    // — they made forward progress for both of us.
    // CAS branches:
    //   (a) doc absent → upsert
    //   (b) doc's ts strictly older than newTs → strict forward move, safe
    //       regardless of stored objectId (we're skipping past that whole
    //       second anyway)
    //   (c) doc still at our exact observed anchor (oldTs, oldOid) → same
    //       state we saw, safe to advance
    //
    // We deliberately do NOT match `{ highWaterMark: newTs }` alone — that
    // would let a slower run rewrite a newer same-second objectId back to
    // an older one. The (c) branch already covers the legitimate
    // same-second advance case (we observed oldOid, doc is still at
    // oldOid, advance to newOid).
    const casFilter: any = {
      _id: STATE_DOC_ID as any,
      $or: [
        { highWaterMark: { $exists: false } },
        { highWaterMark: { $lt: newTs } },
      ],
    };
    if (oldTs) {
      // Match observed (oldTs, oldOid) exactly, including the null/missing
      // objectId case (cold-start anchor has no highWaterObjectId field).
      casFilter.$or.push(
        oldOid == null
          ? {
              highWaterMark: oldTs,
              $or: [
                { highWaterObjectId: null },
                { highWaterObjectId: { $exists: false } },
              ],
            }
          : { highWaterMark: oldTs, highWaterObjectId: oldOid },
      );
    }

    const res = await db.collection(STATE_COLLECTION).updateOne(
      casFilter,
      {
        $set: {
          highWaterMark: newTs,
          highWaterObjectId: newOid,
          updatedAt: new Date(),
          lastTickStats: tickStats,
        },
      },
      { upsert: true },
    );
    if (res.matchedCount === 0 && res.upsertedCount === 0) {
      console.log(
        `[Cron] protractor-af-log-tail: CAS no-op — overlapping run already advanced past observed anchor (oldTs=${oldTs?.toISOString()} oldOid=${oldOid})`,
      );
    }
  }

  const duration = Date.now() - startedAt;
  console.log(
    `[Cron] protractor-af-log-tail: parsed=${allEvents.length} new=${newEvents.length} dispatched=${dispatched} failed=${failed}${capped ? " capped" : ""} (${duration}ms)`,
  );

  return NextResponse.json({
    ok: true,
    parsed: allEvents.length,
    knownConnectionIds: cidToShopId.size,
    newEvents: newEvents.length,
    dispatched,
    failed,
    capped,
    highWaterMark: advanceTo,
    durationMs: duration,
    failures: failures.length ? failures : undefined,
  });
}
