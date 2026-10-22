import type postgres from "postgres";
import type { Db, ChangeStream } from "mongodb";
import { EJSON } from "bson";
import { builderEnabled as enabled } from "./contract";

/** The stream is operational read-only. Resume token and invalidation commit together.
 * A lost/expired token invalidates everything before reopening; never skip a gap. */
export class ProjectionInvalidation {
  private stream: ChangeStream | null = null;
  constructor(private readonly sql: ReturnType<typeof postgres>, private readonly db: Db) {}
  async poll() {
    if (!enabled()) return { status: "disabled" };
    // Serializes stream consumers across processes without a lease-expiry race.
    return this.sql.begin(async tx => {
      await tx.unsafe("SET LOCAL statement_timeout='2000ms'");
      const [lock] = await tx.unsafe("SELECT pg_try_advisory_xact_lock(73215,1) acquired");
      if (!lock.acquired) return { status: "busy" };
      const [cursor] = await tx.unsafe("SELECT resume_token FROM reporting_invoice.change_cursors WHERE name='mongo'");
      if (!this.stream) {
        if (!cursor?.resume_token) await tx.unsafe("UPDATE reporting_invoice.scopes SET revision=revision+1,invalidated_at=clock_timestamp()");
        this.stream = this.db.watch([{ $match: { $or: [
          { "ns.coll": { $in: [
            "normalized_work_orders", "normalized_service_jobs", "normalized_line_items", "normalized_payments",
            "protractor_work_orders", "protractor_invoices", "protractor_invoice_cache",
            "operator_history_import_pages", "operator_history_import_jobs", "operator_history_import_days",
            "operator_history_import_receipts",
          ] } }, { operationType: { $in: ["drop", "rename", "dropDatabase", "invalidate"] } },
        ] } }], {
          ...(cursor?.resume_token ? { resumeAfter: EJSON.deserialize(cursor.resume_token) } : {}),
          maxAwaitTimeMS: 1000, batchSize: 1,
        });
      }
      try {
        const event = await this.stream.tryNext();
        // Watch relevant stored-evidence mutations, including drop/rename/invalidate.
        if (event) await tx.unsafe("UPDATE reporting_invoice.scopes SET revision=revision+1,invalidated_at=clock_timestamp()");
        const token = this.stream.resumeToken;
        // Don't advertise caught-up while there may be queued events.
        if (token) await tx.unsafe(`INSERT INTO reporting_invoice.change_cursors(name,resume_token,observed_at)
          VALUES('mongo',$1::text::jsonb,$2) ON CONFLICT(name) DO UPDATE
          SET resume_token=excluded.resume_token,observed_at=excluded.observed_at`,
        [JSON.stringify(EJSON.serialize(token)), event ? new Date(0) : new Date()]);
        return { status: event ? "invalidated" : "caught_up" };
      } catch (error) {
        await this.stream.close(); this.stream = null;
        await tx.unsafe("UPDATE reporting_invoice.scopes SET revision=revision+1,invalidated_at=clock_timestamp()");
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
  async close() { await this.stream?.close(); this.stream = null; }
}
