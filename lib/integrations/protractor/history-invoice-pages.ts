// Smaller payloads do not authorize additional requests or relaxed byte limits.
export const HISTORY_INVOICE_PAGE_SIZE = 25;
export const FLEET_HISTORY_MAX_WINDOW_DAYS = 7;
/** Applies only inside an approved dedicated-worker permit, not other syncs. */
export function fleetHistoryWindowDays(chunkEnd: Date, pending?: { chunkEnd?: unknown; days?: unknown }): number {
  if (!Number.isFinite(chunkEnd.getTime())) throw new Error("Invalid history cursor");
  if (!pending?.chunkEnd || new Date(pending.chunkEnd as string).getTime() !== chunkEnd.getTime())
    return FLEET_HISTORY_MAX_WINDOW_DAYS;
  const prior = Number(pending.days);
  if (!Number.isSafeInteger(prior) || prior < 1) return FLEET_HISTORY_MAX_WINDOW_DAYS;
  return Math.max(1, Math.floor(Math.min(FLEET_HISTORY_MAX_WINDOW_DAYS, prior) / 2));
}
export function historyChunkCursor(
  chunkStart: Date, chunkEnd: Date, oldestDate: Date, hadError: boolean, hitPageCap: boolean,
  retainFailedFetch = false,
) {
  const hold = hadError || hitPageCap || retainFailedFetch;
  const nextChunkEnd = hold ? chunkEnd : chunkStart;
  return { nextChunkEnd, complete: !hold && nextChunkEnd <= oldestDate,
    clearPendingAttempt: !hitPageCap && !retainFailedFetch };
}
type PageResult = { ok: boolean; data?: { ItemCollection?: unknown }; error?: string };
export async function collectHistoryInvoicePages(
  fetchPage: (take: number, skip: number) => Promise<PageResult>,
  maxPages: number,
): Promise<{ invoices: any[]; hitPageCap: boolean; hadError: boolean }> {
  const invoices: any[] = [];
  const seen = new Set<string>();
  if (!Number.isSafeInteger(maxPages) || maxPages < 1)
    return { invoices, hitPageCap: false, hadError: true };
  let skip = 0;
  for (let request = 0; request < maxPages; request++) {
    if (skip > 10000) return { invoices, hitPageCap: true, hadError: false };
    // Failure (including oversized response) ends the pass. The transport's
    // existing breaker/backoff remains authoritative; never immediately retry.
    const result = await fetchPage(HISTORY_INVOICE_PAGE_SIZE, skip);
    if (!result.ok) return { invoices, hitPageCap: false, hadError: true };
    const items = result.data?.ItemCollection;
    if (!Array.isArray(items) || items.length > HISTORY_INVOICE_PAGE_SIZE)
      return { invoices, hitPageCap: false, hadError: true };
    if (items.some(item => !item || typeof item.ID !== "string" || !item.ID.trim()))
      return { invoices, hitPageCap: false, hadError: true };
    // Repeated pages/overlapping IDs cannot prove that the range is complete.
    for (const item of items) {
      if (seen.has(item.ID)) return { invoices, hitPageCap: false, hadError: true };
      seen.add(item.ID);
      invoices.push(item);
    }
    if (items.length < HISTORY_INVOICE_PAGE_SIZE)
      return { invoices, hitPageCap: false, hadError: false };
    skip += items.length;
  }
  return { invoices, hitPageCap: true, hadError: false };
}
