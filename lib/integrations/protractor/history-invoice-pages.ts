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
type RejectionReason = "invalid_page_budget" | "upstream_request_failed" |
  "missing_item_collection" | "non_array_item_collection" | "overfull_page" |
  "invalid_invoice_id" | "duplicate_invoice_id" | "offset_limit" | "page_budget_exhausted";
export interface HistoryInvoicePageDiagnostic {
  reason: RejectionReason;
  pageNumber: number;
  skip: number;
  requestedTake: number;
  receivedCount: number | null;
  acceptedCount: number;
  invalidIdCount: number | null;
}
export interface HistoryInvoicePagesResult {
  invoices: any[];
  hitPageCap: boolean;
  hadError: boolean;
  diagnostic?: HistoryInvoicePageDiagnostic;
}
// Fixed fields only: never log payloads, IDs, URLs, or provider error text.
export function reportHistoryInvoicePageDiagnostic(shopId: number, d: HistoryInvoicePageDiagnostic) {
  console.warn(JSON.stringify({
    event: "protractor_history_invoice_page_rejected", shopId,
    reason: d.reason, pageNumber: d.pageNumber, skip: d.skip,
    requestedTake: d.requestedTake, receivedCount: d.receivedCount,
    acceptedCount: d.acceptedCount, invalidIdCount: d.invalidIdCount,
  }));
}
export async function collectHistoryInvoicePages(
  fetchPage: (take: number, skip: number) => Promise<PageResult>,
  maxPages: number,
): Promise<HistoryInvoicePagesResult> {
  const invoices: any[] = [];
  const seen = new Set<string>();
  let skip = 0;
  let pageNumber = 0;
  const reject = (reason: RejectionReason, receivedCount: number | null = null,
    invalidIdCount: number | null = null, hitPageCap = false): HistoryInvoicePagesResult => ({
    invoices, hitPageCap, hadError: !hitPageCap,
    diagnostic: { reason, pageNumber, skip, requestedTake: HISTORY_INVOICE_PAGE_SIZE,
      receivedCount, acceptedCount: invoices.length, invalidIdCount },
  });
  if (!Number.isSafeInteger(maxPages) || maxPages < 1)
    return reject("invalid_page_budget");
  for (let request = 0; request < maxPages; request++) {
    if (skip > 10000) return reject("offset_limit", null, null, true);
    pageNumber = request + 1;
    // Failure (including oversized response) ends the pass. The transport's
    // existing breaker/backoff remains authoritative; never immediately retry.
    const result = await fetchPage(HISTORY_INVOICE_PAGE_SIZE, skip);
    if (!result.ok) return reject("upstream_request_failed");
    const items = result.data?.ItemCollection;
    if (items === undefined) return reject("missing_item_collection");
    if (!Array.isArray(items)) return reject("non_array_item_collection");
    if (items.length > HISTORY_INVOICE_PAGE_SIZE) return reject("overfull_page", items.length);
    const invalidIdCount = items.filter(item => !item || typeof item.ID !== "string" || !item.ID.trim()).length;
    if (invalidIdCount) return reject("invalid_invoice_id", items.length, invalidIdCount);
    // Repeated pages/overlapping IDs cannot prove that the range is complete.
    for (const item of items) {
      if (seen.has(item.ID)) return reject("duplicate_invoice_id", items.length);
      seen.add(item.ID);
      invoices.push(item);
    }
    if (items.length < HISTORY_INVOICE_PAGE_SIZE)
      return { invoices, hitPageCap: false, hadError: false };
    skip += items.length;
  }
  return reject("page_budget_exhausted", null, null, true);
}
