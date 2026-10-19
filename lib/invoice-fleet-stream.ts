import { aggregateInvoiceHours, combineInvoiceLocationDiagnostics, type InvoiceHoursFact } from "./invoice-hours-contract";
import { INVOICE_HOURS_MAX_ORDERS, INVOICE_VERIFIED_PREDICATE } from "./invoice-hours-query";
import { invoiceFleetParams } from "./invoice-fleet-aggregation";
import type { ReportingMetricValues } from "./reporting-kpi-contract";

export const INVOICE_STREAM_LIMITS = Object.freeze({
  pageRows: 256, fleetRows: 500_000, locationRows: INVOICE_HOURS_MAX_ORDERS,
  fleetBytes: 64 * 1024 * 1024, locationBytes: 16 * 1024 * 1024,
  rowBytes: 32 * 1024,
});
type Query = (sql: string, params: unknown[]) => PromiseLike<Record<string, any>[]>;

// No ORDER BY, joins, aggregation, DISTINCT, materialization or scrollable
// cursor: this projection has no temporary-file-producing executor operators.
// Oversized JSON never crosses the wire. All history is read for a location,
// so out-of-period peers can still veto or resolve an invoice identity.
export const INVOICE_STREAM_SELECT = `
SELECT wo.id,wo.shop_id,wo.status,wo.provenance->>'sourceSystem' provider,
  CASE WHEN octet_length(coalesce((wo.provenance->'sourceIds')::text,'')) <= 32768
    THEN ARRAY(SELECT s->>'idValue'
      FROM jsonb_array_elements(coalesce(wo.provenance->'sourceIds','[]'::jsonb)) s
      WHERE s->>'system'=wo.provenance->>'sourceSystem'
        AND s->>'idType' IN ('invoice_id','work_order_id')) END alias_values,
  CASE WHEN octet_length(coalesce((wo.custom_fields->'invoiceHours')::text,'')) <= 32768
    THEN CASE WHEN jsonb_typeof(wo.custom_fields->'invoiceHours')='object'
      THEN jsonb_build_object('version',wo.custom_fields->'invoiceHours'->'version',
        'id',wo.custom_fields->'invoiceHours'->'id','date',wo.custom_fields->'invoiceHours'->'date',
        'sold',wo.custom_fields->'invoiceHours'->'sold',
        'presented',wo.custom_fields->'invoiceHours'->'presented')
      ELSE wo.custom_fields->'invoiceHours' END END invoice_evidence,
  octet_length(coalesce((wo.provenance->'sourceIds')::text,'')) +
    octet_length(coalesce((wo.custom_fields->'invoiceHours')::text,'')) AS evidence_bytes,
  coalesce((${INVOICE_VERIFIED_PREDICATE}),false) verified
FROM normalized_work_orders wo
WHERE wo.shop_id=$1 AND NOT coalesce((wo.soft_delete->>'isDeleted')::boolean,false)
  AND wo.status::text NOT IN ('voided','cancelled')`;

export async function admitInvoiceStream(query: Query) {
  // Must be the first transaction operation, before any snapshot is acquired.
  await query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY", []);
  await query("SET LOCAL work_mem='2MB'", []);
  await query("SET LOCAL max_parallel_workers_per_gather=0", []);
  await query("SET LOCAL lock_timeout='1s'", []);
  await query("SET LOCAL idle_in_transaction_session_timeout='5s'", []);
  const rows = await query("SELECT pg_try_advisory_xact_lock(19470221,1) AS admitted", []);
  if (rows.length !== 1 || rows[0].admitted !== true)
    throw Error("Another fleet invoice report is running. Please retry shortly.");
}

/** Caller owns the admitted transaction, cancellation and one absolute deadline.
 * No intermediate location results escape this function on failure. */
export async function streamInvoiceFleet(
  query: Query, authorized: number[], requested: number[], start: Date, end: Date,
  deadlineAt: number,
) {
  invoiceFleetParams(authorized, requested, start, end);
  const limits = INVOICE_STREAM_LIMITS;
  const locations = new Map<number, Partial<ReportingMetricValues>>();
  let totalRows = 0, totalBytes = 0;
  const checkTime = () => {
    if (Date.now() >= deadlineAt) throw Error("Fleet invoice reporting exceeded its shared time budget.");
  };
  for (const shop of requested) {
    checkTime();
    const facts: InvoiceHoursFact[] = [];
    // Match the SQL aggregate's fail-closed treatment of ambiguous aliases.
    const aliases = new Map<string, string>();
    let locationBytes = 0;
    await query(`DECLARE invoice_metadata_cursor NO SCROLL CURSOR FOR ${INVOICE_STREAM_SELECT}`, [shop]);
    for (;;) {
      checkTime();
      const page = await query(`FETCH FORWARD ${limits.pageRows} FROM invoice_metadata_cursor`, []);
      if (page.length > limits.pageRows) throw Error("Invalid invoice page size.");
      for (const row of page) {
        checkTime();
        if (row.shop_id !== shop) throw Error("Invoice row is outside the authorized location.");
        const bytes = Buffer.byteLength(JSON.stringify(row), "utf8");
        totalRows++; totalBytes += bytes; locationBytes += bytes;
        const exceeded = row.evidence_bytes > limits.rowBytes || bytes > limits.rowBytes ? "row bytes"
          : totalRows > limits.fleetRows ? "fleet rows"
          : facts.length >= limits.locationRows ? "location rows"
          : totalBytes > limits.fleetBytes ? "fleet bytes"
          : locationBytes > limits.locationBytes ? "location bytes" : null;
        if (exceeded)
          throw Error(`Fleet invoice reporting exceeded its bounded metadata budget (${exceeded}). No partial totals were published.`);
        if (!Array.isArray(row.alias_values) || row.alias_values.some((id: unknown) => typeof id !== "string"))
          throw Error("Stored invoice aliases are unsupported.");
        row.source_ids = row.alias_values.map((idValue: string) => ({
          system: row.provider, idType: "invoice_id", idValue,
        }));
        delete row.alias_values;
        if (row.invoice_evidence != null) {
          const e = row.invoice_evidence;
          if (row.verified !== true || e.version !== 1 ||
              [e.sold, e.presented].some(v => v !== null && (typeof v !== "number" || !Number.isFinite(v))))
            throw Error("Stored invoice evidence is unsupported. No totals were published.");
        } else {
          const ids = (row.source_ids ?? []).filter((s: any) => s.system === row.provider &&
            ["invoice_id", "work_order_id"].includes(s.idType))
            .map((s: any) => `${row.provider}:${String(s.idValue).toLowerCase()}`);
          const key = ids[0] ?? `${row.provider}:row:${row.id}`;
          const signature = JSON.stringify(ids);
          if (aliases.has(key) && aliases.get(key) !== signature)
            throw Error("Stored invoice aliases are ambiguous. No totals were published.");
          aliases.set(key, signature);
        }
        facts.push(row as InvoiceHoursFact);
      }
      if (page.length < limits.pageRows) break;
    }
    await query("CLOSE invoice_metadata_cursor", []);
    checkTime();
    locations.set(shop, aggregateInvoiceHours(facts, start, end).summary);
    checkTime();
  }
  return { summary: combineInvoiceLocationDiagnostics(requested, locations), locations };
}
