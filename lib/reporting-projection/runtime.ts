import type postgres from "postgres";
import type { Db } from "mongodb";
import assert from "node:assert/strict";
import { builderEnabled as enabled } from "./contract";
import { StoredInvoiceInventory } from "./source";
import { InvoiceProjectionWorker } from "./worker";
import { ProjectionInvalidation } from "./invalidation";

/** Explicit worker entry, not startup/cron activation. Connections must be provided
 * by the approved operator runtime: source PG/Mongo read-only; reporting PG restricted.
 * Call repeatedly on a bounded allowlist, including after process restarts. */
export function projectionRuntime(reporting: ReturnType<typeof postgres>, sourcePg: ReturnType<typeof postgres>, mongo: Db) {
  const source = new StoredInvoiceInventory(async (text, params) =>
    sourcePg.begin(async tx => {
      await tx.unsafe("SET TRANSACTION READ ONLY");
      await tx.unsafe("SET LOCAL statement_timeout='2000ms'");
      return tx.unsafe(text, params);
    }) as unknown as Promise<any[]>, mongo);
  const worker = new InvoiceProjectionWorker(reporting, source);
  const invalidation = new ProjectionInvalidation(reporting, mongo);
  return {
    close: () => invalidation.close(),
    /** Operator/scheduler entry independent of inventory. Never enables readers.
     * Bound each invocation; caller must provide its own scheduling lifecycle. */
    async catchUp(options: { polls?: number; budgetMs?: number; signal?: AbortSignal } = {}) {
      const polls = options.polls ?? 10, budget = options.budgetMs ?? 15_000;
      assert.ok(Number.isSafeInteger(polls) && polls > 0 && polls <= 40);
      assert.ok(Number.isSafeInteger(budget) && budget > 0 && budget <= 60_000);
      const deadline = Date.now() + budget;
      // Retry only this explicitly bounded feed-drain entry. Inventory ticks
      // continue to stop immediately on a feed error.
      let events = 0, completed = 0, retries = 0;
      let lastFailure: Awaited<ReturnType<typeof invalidation.poll>> | undefined;
      while (completed < polls && Date.now() < deadline && !options.signal?.aborted) {
        const result = await invalidation.poll(options.signal, deadline);
        completed++;
        events += "events" in result ? result.events ?? 0 : 0;
        if (result.status === "stream_unavailable" && "diagnostic" in result &&
            ["timeout", "network", "server_selection"].includes(result.diagnostic?.category ?? "") &&
            retries < 2 && completed < polls && Date.now() < deadline && !options.signal?.aborted) {
          lastFailure = result;
          // Outside the transaction: no scope/advisory lock during backoff.
          await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", done); resolve(); };
            const timer = setTimeout(done, Math.min(100 * (retries + 1), deadline - Date.now()));
            options.signal?.addEventListener("abort", done, { once: true });
            if (options.signal?.aborted) done();
          });
          retries++;
          continue;
        }
        if (result.status !== "draining") return { ...result, events, polls: completed, retries };
        lastFailure = undefined;
      }
      return { ...lastFailure, status: options.signal?.aborted ? "cancelled" : lastFailure?.status ?? "draining",
        events, polls: completed, retries };
    },
    async tick(shop: number, signal?: AbortSignal) {
      if (!enabled()) return { status: "disabled" };
      assert.ok(Number.isSafeInteger(shop) && shop > 0);
      if (signal?.aborted) return { status: "cancelled_tick" };
      const changes = await invalidation.poll(signal);
      if (!["caught_up", "draining"].includes(changes.status)) return changes;
      const [current] = await reporting.unsafe(`SELECT b.id FROM reporting_invoice.scopes s
        JOIN reporting_invoice.builds b ON b.id=s.published WHERE s.shop_id=$1 AND b.revision=s.revision
        AND b.verified_at>clock_timestamp()-interval '4 minutes'`, [shop]);
      if (current && changes.status === "caught_up") return { status: "fresh" };
      const id = await worker.start(shop);
      if (!id) return { status: "disabled" };
      const result = await worker.tick(id, { signal, inventoryOnly: changes.status !== "caught_up" });
      const after = await invalidation.poll(signal);
      // Do not hide a failed post-work poll behind a successful inventory tick.
      // The saved worker checkpoint remains committed; operators must stop.
      if (!["caught_up", "draining"].includes(after.status))
        return { ...after, buildId: id, workerStatus: result.status };
      // Never report a publication as fresh based on a poll made before source
      // reads. The reader independently checks revision, watcher age and expiry.
      const [valid] = result.status === "complete" ? await reporting.unsafe(`SELECT b.id
        FROM reporting_invoice.builds b JOIN reporting_invoice.scopes s ON s.shop_id=b.shop_id
        WHERE b.id=$1 AND b.revision=s.revision AND b.verified_at>clock_timestamp()-interval '5 minutes'`, [id]) : [];
      if (result.status === "complete" && (after.status !== "caught_up" || !valid))
        return { status: "awaiting_verification", buildId: id, feed: after.status };
      console.info("[invoice-projection]", { shopId: shop, buildId: id, ...result });
      return { ...result, buildId: id };
    },
  };
}
