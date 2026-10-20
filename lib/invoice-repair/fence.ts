import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";

export const INVOICE_FENCE_LOCK = [19470222, 2] as const;
export class InvoiceRepairFencedError extends Error {
  readonly code = "INVOICE_REPAIR_FENCED";
  constructor() { super("Invoice data is unavailable while repair safety is unresolved"); }
}
type Scope = { active: boolean; unknown: boolean; installation: string | null; pending: Set<Promise<unknown>> };

/**
 * All normal access holds a shared lock for its entire operation. Repair
 * admission takes the exclusive counterpart before persisting the fence.
 * Connection loss, missing schema and unresolved operations fail closed.
 * No cached decision, TTL, environment bypass, or operator boolean.
 */
export class InvoiceFence {
  private readonly scope = new AsyncLocalStorage<Scope>();
  constructor(private readonly coordinator: ReturnType<typeof postgres>) {}
  isScoped() { return this.scope.getStore()?.active === true; }
  retainUnknown() {
    const scope = this.scope.getStore();
    if (scope?.active) scope.unknown = true;
  }

  async run<T>(work: () => Promise<T>, mongoInstallation?: string | null): Promise<T> {
    const inherited = this.scope.getStore();
    if (inherited?.active) {
      if (mongoInstallation !== undefined && mongoInstallation !== inherited.installation)
        throw new InvoiceRepairFencedError();
      const operation = Promise.resolve().then(work);
      inherited.pending.add(operation);
      try { return await operation; }
      catch (error) { inherited.unknown = true; throw error; }
      finally { inherited.pending.delete(operation); }
    }
    const operation = randomUUID();
    const installation = await this.coordinator.begin(async tx => {
      await tx.unsafe("SET LOCAL lock_timeout='1s'");
      const [lock] = await tx.unsafe("SELECT pg_try_advisory_xact_lock_shared($1,$2) AS admitted", [...INVOICE_FENCE_LOCK]);
      if (!lock.admitted) throw new InvoiceRepairFencedError();
      const [schema] = await tx.unsafe("SELECT to_regclass('invoice_repair_installation') IS NOT NULL AS installed");
      // No repairs can be admitted before the separately approved installation.
      // Installation itself requires a drained, verified deployment inventory.
      if (!schema.installed) {
        if (mongoInstallation != null) throw new InvoiceRepairFencedError();
        return null;
      }
      const configured = await tx.unsafe("SELECT installation_key FROM invoice_repair_installation WHERE id=1 AND protocol=1");
      if (configured.length !== 1 || (mongoInstallation !== undefined && mongoInstallation !== configured[0].installation_key))
        throw new InvoiceRepairFencedError();
      const rows = await tx.unsafe("SELECT operation FROM invoice_repair_fence WHERE id=1");
      if (rows.length !== 1 || rows[0].operation !== null) throw new InvoiceRepairFencedError();
      // Commit admission BEFORE invoking a different database. A severed PG
      // connection cannot release a lock while Mongo is still executing.
      await tx.unsafe("INSERT INTO invoice_repair_access(id) VALUES($1)", [operation]);
      const service = process.env.RENDER_SERVICE_ID, instance = process.env.RENDER_INSTANCE_ID,
        revision = process.env.RENDER_GIT_COMMIT;
      if (service && instance && revision) {
        await tx.unsafe(`INSERT INTO invoice_repair_writer_runtime
          (service_id,instance_id,revision,protocol) VALUES($1,$2,$3,1)
          ON CONFLICT(service_id,instance_id) DO UPDATE SET
          revision=EXCLUDED.revision,protocol=1,observed_at=clock_timestamp()`,
        [service, instance, revision]);
      }
      return configured[0].installation_key as string;
    });
    const scope: Scope = { active: true, unknown: false, installation, pending: new Set() };
    let completed = false;
    try {
      const result = await this.scope.run(scope, work);
      completed = true;
      return result;
    } finally {
      while (scope.pending.size) {
        const outcomes = await Promise.allSettled([...scope.pending]);
        if (outcomes.some(r => r.status === "rejected")) completed = false;
      }
      scope.active = false;
      // Unknown outcomes remain durable and veto repair admission. Never
      // expire active rows based on process liveness or an operator boolean.
      if (installation && completed && !scope.unknown)
        await this.coordinator.unsafe("DELETE FROM invoice_repair_access WHERE id=$1", [operation]);
    }
  }
}
