import type postgres from "postgres";
import type { Db } from "mongodb";
import { enabled } from "./contract";
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
    async tick(shop: number, signal?: AbortSignal) {
      if (!enabled()) return { status: "disabled" };
      const changes = await invalidation.poll();
      if (changes.status !== "caught_up") return changes;
      const [current] = await reporting.unsafe(`SELECT b.id FROM reporting_invoice.scopes s
        JOIN reporting_invoice.builds b ON b.id=s.published WHERE s.shop_id=$1 AND b.revision=s.revision
        AND b.verified_at>clock_timestamp()-interval '4 minutes'`, [shop]);
      if (current) return { status: "fresh" };
      const id = await worker.start(shop);
      if (!id) return { status: "disabled" };
      const result = await worker.tick(id, { signal });
      await invalidation.poll();
      console.info("[invoice-projection]", { shopId: shop, buildId: id, ...result });
      return { ...result, buildId: id };
    },
  };
}
