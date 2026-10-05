import { getClient } from "@/lib/db/drizzle";
import native from "@/docs/reporting/jwt-701-september-1-native-identities.json";
import type { StoredInvoiceEvidence } from "@/lib/jwt-invoice-recovery-evidence";

// Fixed, indexed shop/number lookup. No scans by date or source JSON, no writes.
export async function readJwtInvoicePreviewStored(client = getClient()): Promise<StoredInvoiceEvidence[]> {
  const ids = [...new Set(native.flatMap(n => [n.wo, n.invoice]))];
  const deadline = Date.now() + 8000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = client.begin("read only", async tx => {
    if (Date.now() >= deadline) throw new Error("Database queue deadline");
    await tx.unsafe(`SET LOCAL statement_timeout = ${Math.max(1, Math.min(5000, deadline - Date.now()))}`);
    if (Date.now() >= deadline) throw new Error("Database queue deadline");
    const rows = await tx.unsafe<StoredInvoiceEvidence[]>(`
      SELECT id, work_order_number, status,
        (coalesce(closed_date, completed_date) AT TIME ZONE 'UTC')::date::text AS business_date,
        coalesce((soft_delete->>'isDeleted')::boolean,false) AS deleted
      FROM normalized_work_orders
      WHERE shop_id = 227 AND work_order_number = ANY($1::text[])
      LIMIT 51`, [`{${ids.join(",")}}`]);
    if (rows.length > 50) throw new Error("Ambiguous oversized identity result");
    return Array.from(rows);
  }) as Promise<StoredInvoiceEvidence[]>;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Database comparison deadline")), 8000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
