import postgres from "postgres";
import { InvoiceFence } from "./fence";
import { guardMongoClient, guardPostgres } from "./guarded-drivers";
import { instrumentPgClientForSlowQueries } from "../slow-query/tracker";

let fence: InvoiceFence | undefined;
async function heartbeat(coordinator: ReturnType<typeof postgres>) {
  const service = process.env.RENDER_SERVICE_ID, instance = process.env.RENDER_INSTANCE_ID,
    revision = process.env.RENDER_GIT_COMMIT;
  if (!service || !instance || !revision) return;
  const [schema] = await coordinator.unsafe("SELECT to_regclass('invoice_repair_installation') IS NOT NULL AS installed");
  if (!schema.installed) return; // No writes before separately approved installation.
  await coordinator.unsafe(`INSERT INTO invoice_repair_writer_runtime
    (service_id,instance_id,revision,protocol)
    SELECT $1,$2,$3,1 FROM invoice_repair_installation WHERE id=1 AND protocol=1
    ON CONFLICT(service_id,instance_id) DO UPDATE SET
    revision=EXCLUDED.revision,protocol=1,observed_at=clock_timestamp()`, [service, instance, revision]);
}
export function invoiceFence(): InvoiceFence {
  if (!fence) {
    const url = process.env.DATAONE_DATABASE_URL || process.env.DATABASE_URL;
    if (!url) throw Error("Invoice repair coordinator is not configured");
    // Separate pool: keeping a shared lock cannot exhaust the caller's pool
    // while it waits for its own transaction connection.
    const coordinator = instrumentPgClientForSlowQueries(
      postgres(url, { max: 4, connect_timeout: 5, idle_timeout: 20 }),
    );
    fence = new InvoiceFence(coordinator);
    if (process.env.RENDER_SERVICE_ID && process.env.RENDER_INSTANCE_ID && process.env.RENDER_GIT_COMMIT) {
      // Evidence collection must continue while the data fence is closed.
      // This never admits data work, starts/resumes workers or clears a fence.
      const refresh = () => { void heartbeat(coordinator).catch(() =>
        console.warn("[invoice-repair] Runtime verification unavailable; repair admission remains fail-closed")); };
      refresh();
      setInterval(refresh, 10_000).unref();
    }
  }
  return fence;
}
export const fenceMongoClient = <T extends object>(client: T): T =>
  guardMongoClient(client, invoiceFence());
export const fencePostgres = <T extends object>(client: T): T =>
  guardPostgres(client, invoiceFence());
