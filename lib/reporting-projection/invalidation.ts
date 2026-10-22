import type postgres from "postgres";
import type { Db, ChangeStream } from "mongodb";
import { EJSON } from "bson";
import { builderEnabled as enabled } from "./contract";

export const FEED_LIMITS = { events: 100, budgetMs: 1500, awaitMs: 100 } as const;

/** Only event-time ownership is authoritative. updateLookup alone can reflect a
 * later move, and deletes without preimages cannot safely be scoped. */
export function changedShops(event: any): number[] | null {
  const owner = (doc: any): number | null => {
    const value = doc?.shopId;
    if (!(typeof value === "number" || typeof value === "string" && /^[1-9]\d*$/.test(value))) return null;
    const shop = Number(value);
    return Number.isSafeInteger(shop) && shop > 0 ? shop : null;
  };
  if (event.operationType === "insert") {
    const shop = owner(event.fullDocument);
    return shop === null ? null : [shop];
  }
  if (event.operationType === "delete") {
    const shop = owner(event.fullDocumentBeforeChange);
    return shop === null ? null : [shop];
  }
  // Replacement/update postimages obtained by lookup aren't event-time images.
  // Both images plus unchanged ownership in the update description prove scope
  // only for ordinary updates that did not touch shopId.
  if (event.operationType === "update") {
    const before = owner(event.fullDocumentBeforeChange);
    const after = owner(event.fullDocument);
    const description = event.updateDescription;
    const paths = [...Object.keys(description?.updatedFields ?? {}),
      ...(description?.removedFields ?? [])];
    if (before !== null && after === before && description &&
      !paths.some(p => p === "shopId" || p.startsWith("shopId."))) return [before];
  }
  return null;
}

/** The stream is operational read-only. Resume token and invalidation commit together.
 * A lost/expired token invalidates everything before reopening; never skip a gap. */
export class ProjectionInvalidation {
  private stream: ChangeStream | null = null;
  constructor(private readonly sql: ReturnType<typeof postgres>, private readonly db: Db) {}
  async poll(signal?: AbortSignal) {
    if (!enabled()) return { status: "disabled" };
    // Serializes stream consumers across processes without a lease-expiry race.
    return this.sql.begin(async tx => {
      await tx.unsafe("SET LOCAL statement_timeout='2000ms'");
      await tx.unsafe("SET LOCAL lock_timeout='250ms'");
      const [lock] = await tx.unsafe("SELECT pg_try_advisory_xact_lock(73215,1) acquired");
      if (!lock.acquired) return { status: "busy" };
      const [cursor] = await tx.unsafe("SELECT resume_token FROM reporting_invoice.change_cursors WHERE name='mongo'");
      // Another process may have advanced the durable token since our last poll.
      // Never reuse a process-local stream across transactions.
      await this.close();
      if (!cursor?.resume_token) {
        await tx.unsafe("UPDATE reporting_invoice.scopes SET revision=revision+1,invalidated_at=clock_timestamp()");
        await tx.unsafe(`UPDATE reporting_invoice.builds SET phase='failed',failure='stream_gap'
          WHERE phase IN ('inventory','verify','project')`);
      }
      try {
        this.stream = this.db.watch([{ $match: { $or: [
          { "ns.coll": { $in: [
            "normalized_work_orders", "normalized_service_jobs", "normalized_line_items", "normalized_payments",
            "protractor_work_orders", "protractor_invoices", "protractor_invoice_cache",
            "operator_history_import_pages", "operator_history_import_jobs", "operator_history_import_days",
            "operator_history_import_receipts",
          ] } }, { operationType: { $in: ["drop", "rename", "dropDatabase", "invalidate"] } },
        ] } }], {
          ...(cursor?.resume_token ? { resumeAfter: EJSON.deserialize(cursor.resume_token) } : {}),
          fullDocument: "updateLookup", fullDocumentBeforeChange: "whenAvailable",
          maxAwaitTimeMS: FEED_LIMITS.awaitMs, batchSize: FEED_LIMITS.events,
          timeoutMS: 1000,
        });
        const deadline = Date.now() + FEED_LIMITS.budgetMs;
        let events = 0, caughtUp = false, fleet = false;
        let lastEventToken: any = null;
        const shops = new Set<number>();
        while (events < FEED_LIMITS.events && Date.now() < deadline && !signal?.aborted) {
          const event = await this.stream.tryNext();
          if (!event) { caughtUp = true; break; }
          events++;
          if (["drop", "rename", "dropDatabase", "invalidate"].includes(event.operationType))
            throw Object.assign(new Error("source_namespace_gap"), { code: 286 });
          if (!event._id) throw Object.assign(new Error("missing_event_token"), { code: 286 });
          // mongodb 6.19 tryNext does NOT cache event resume tokens. Persist the
          // consumed event's _id ourselves; a batch's end token could skip events.
          lastEventToken = event._id;
          const affected = changedShops(event);
          if (affected === null) fleet = true;
          else affected.forEach(shop => shops.add(shop));
        }
        if (fleet) await tx.unsafe("UPDATE reporting_invoice.scopes SET revision=revision+1,invalidated_at=clock_timestamp()");
        else if (shops.size) await tx.unsafe(`UPDATE reporting_invoice.scopes
          SET revision=revision+1,invalidated_at=clock_timestamp() WHERE shop_id=ANY($1::int[])`,
        [`{${[...shops].join(",")}}`]);
        const token = caughtUp ? this.stream.resumeToken ?? lastEventToken
          : lastEventToken ?? this.stream.resumeToken;
        // Bounded draining is progress, not freshness. Only an observed empty
        // stream WITH a resumable token can certify catch-up.
        if (token) await tx.unsafe(`INSERT INTO reporting_invoice.change_cursors(name,resume_token,observed_at)
          VALUES('mongo',$1::text::jsonb,$2) ON CONFLICT(name) DO UPDATE
          SET resume_token=excluded.resume_token,observed_at=excluded.observed_at`,
        [JSON.stringify(EJSON.serialize(token)), caughtUp ? new Date() : new Date(0)]);
        await this.close();
        return { status: caughtUp && token ? "caught_up" : "draining", events };
      } catch (error) {
        await this.close().catch(() => {});
        // Network/timeout errors aren't proof of history loss. Keep the durable
        // token and retry it next time; withdraw watcher freshness meanwhile.
        if (![260, 280, 286].includes(Number((error as any)?.code))) {
          await tx.unsafe("UPDATE reporting_invoice.change_cursors SET observed_at='epoch' WHERE name='mongo'");
          return { status: "stream_unavailable" };
        }
        await tx.unsafe("UPDATE reporting_invoice.scopes SET revision=revision+1,invalidated_at=clock_timestamp()");
        await tx.unsafe(`UPDATE reporting_invoice.builds SET phase='failed',failure='stream_gap'
          WHERE phase IN ('inventory','verify','project')`);
        await tx.unsafe("DELETE FROM reporting_invoice.change_cursors WHERE name='mongo'");
        // Persist the gap before reporting failure. No source payload/error text is logged.
        return { status: "stream_gap" };
      }
    }).catch(async error => {
      // A failed commit must replay from the durable token, not the advanced stream.
      await this.close();
      throw error;
    });
  }
  async close() {
    const stream = this.stream; this.stream = null;
    await stream?.close();
  }
}
