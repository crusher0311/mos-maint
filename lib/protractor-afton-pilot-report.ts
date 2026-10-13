import { createHash } from "node:crypto";
export const pilotDigest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function pilotInvoiceIds(data: unknown): string[] {
  const rows = Array.isArray(data) ? data : (data as { ItemCollection?: unknown })?.ItemCollection;
  if (!Array.isArray(rows) || rows.length > 100) throw Error("Unexpected invoice page");
  const ids = rows.map(row => {
    if (!row || typeof row.ID !== "string" || !uuid.test(row.ID)) throw Error("Invalid invoice identity");
    return row.ID.toLowerCase();
  });
  if (new Set(ids).size !== ids.length) throw Error("Duplicate invoice identities on page");
  return ids;
}
export function classifyPilotIds(ids: string[], matches: Array<{ source_id: string; id: string }>) {
  return ids.map(id => {
    const rows = new Set(matches.filter(row => row.source_id === id).map(row => row.id));
    return { sourceId: id, result: rows.size > 1 ? "ambiguous" : rows.size === 1 ? "present" : "missing_candidate" };
  });
}
