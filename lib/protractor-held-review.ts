import { createHash } from "node:crypto";
import { extractProtractorServicePackages, getProtractorPackageIdentity, getProtractorPackageLines } from "./integrations/protractor/package-normalization";

export const reviewDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type ReviewScope = { campaignId: string; shopId: number; days: string[] };
export interface ReviewStore {
  campaign(id: string): Promise<any>;
  cursor(id: string): Promise<any>;
  pages(scope: ReviewScope): Promise<any[]>;
  receipts(scope: ReviewScope): Promise<any[]>;
  days(scope: ReviewScope): Promise<any[]>;
  receipt(id: string): Promise<any>;
  ownership(shopId: number, invoiceId: string): Promise<{ canonical: string[]; legacy: string[] }>;
  index(shopId: number, invoiceId: string): Promise<{ servicePackageId: string; sourceType?: string }[]>;
}
export function validateReviewScope(scope: ReviewScope) {
  if (!/^protractor-weekend-\d{4}-\d{2}-\d{2}$/.test(scope.campaignId) ||
      !Number.isSafeInteger(scope.shopId) || scope.shopId < 1 ||
      !Array.isArray(scope.days) || scope.days.length < 1 || scope.days.length > 7 ||
      new Set(scope.days).size !== scope.days.length ||
      scope.days.some(d => !/^\d{4}-\d{2}-\d{2}$/.test(d) ||
        !Number.isFinite(Date.parse(d)) || new Date(d).toISOString().slice(0, 10) !== d))
    throw Error("Explicit campaign, one shop and 1–7 distinct valid days required");
}
function bounded(rows: any[], cap: number, label: string) {
  if (rows.length > cap) throw Error(`${label} cap exceeded; narrow the scope`);
  return rows;
}

/** No mutations or provider interface. Failed reads are never interpreted as absence. */
export async function reviewHeldImports(store: ReviewStore, scope: ReviewScope) {
  validateReviewScope(scope);
  const started = Date.now();
  const deadline = () => { if (Date.now() - started > 120000) throw Error("Review deadline exceeded; narrow the scope"); };
  const campaign = await store.campaign(scope.campaignId);
  const entry = campaign?.shops?.find((s: any) => s.shopId === scope.shopId);
  if (!entry || scope.days.some(d => !entry.pendingDays?.includes(d))) throw Error("Scope outside stored campaign");
  const cursor = await store.cursor(`${scope.campaignId}:shop:${scope.shopId}`);
  const pages = bounded(await store.pages(scope), 20, "Pages");
  const receipts = bounded(await store.receipts(scope), 500, "Receipts");
  const days = bounded(await store.days(scope), 7, "Days");
  for (const row of [...pages, ...receipts, ...days]) {
    if (row.campaignId !== scope.campaignId || row.shopId !== scope.shopId || !scope.days.includes(row.day))
      throw Error("Out-of-scope evidence");
  }
  const receiptMap = new Map(receipts.map(r => [String(r._id), r]));
  if (receiptMap.size !== receipts.length) throw Error("Duplicate receipt identity");
  const invoices = new Map<string, { invoice: any; pages: string[]; digests: Set<string> }>();
  let rawOccurrences = 0, duplicateOccurrences = 0;
  for (const page of pages) {
    if (!Array.isArray(page.invoices) || page.invoices.length > 100 || reviewDigest(page.invoices) !== page.digest)
      throw Error("Invalid archived page digest or size");
    for (const invoice of page.invoices) {
      if (typeof invoice.ID !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(invoice.ID))
        throw Error("Invalid archived invoice identity");
      rawOccurrences++;
      const id = invoice.ID.toLowerCase();
      if (invoices.has(id)) duplicateOccurrences++;
      const item = invoices.get(id) ?? { invoice, pages: [], digests: new Set<string>() };
      item.pages.push(String(page._id)); item.digests.add(reviewDigest(invoice));
      invoices.set(id, item);
    }
  }
  bounded([...invoices], 500, "Invoices");
  const rows: any[] = [];
  const seenReceipts = new Set<string>();
  for (const [invoiceId, raw] of invoices) {
    deadline();
    const receiptId = `${scope.campaignId}:${scope.shopId}:${reviewDigest(invoiceId)}`;
    const receipt = await store.receipt(receiptId);
    if (receipt && (receipt.campaignId !== scope.campaignId || receipt.shopId !== scope.shopId))
      throw Error("Receipt ownership mismatch");
    if (receiptMap.has(receiptId) && reviewDigest(receiptMap.get(receiptId)) !== reviewDigest(receipt))
      throw Error("Receipt changed during review; retry a stable scope");
    if (receiptMap.has(receiptId)) seenReceipts.add(receiptId);
    const prior = entry.priorJobId ? await store.receipt(`${entry.priorJobId}:${reviewDigest(invoiceId)}`) : null;
    const evidence: any = { invoiceId, receiptId, receiptStatus: receipt?.status ?? null,
      receiptDay: receipt?.day ?? null, priorReceiptStatus: prior?.status ?? null,
      sourceDigests: [...raw.digests], pageIds: raw.pages };
    let classification = "unreceipted-unknown";
    let missing: string[] = [];
    if (raw.digests.size !== 1 || (receipt && receipt.sourceDigest !== [...raw.digests][0])) {
      classification = "evidence-conflict";
    } else {
      try {
        evidence.ownership = await store.ownership(scope.shopId, invoiceId);
        const indexed = bounded(await store.index(scope.shopId, invoiceId), 1000, "Index entries");
        const packages = extractProtractorServicePackages(raw.invoice)
          .filter((p: any) => (p.ServicePackageHeader?.Title || p.Title || p.title) && getProtractorPackageLines(p).length);
        const keys = packages.map(p => String(getProtractorPackageIdentity(p) || "").toLowerCase());
        evidence.expectedPackageIds = keys;
        evidence.indexedPackageIds = indexed.map(j => j.servicePackageId);
        const have = new Set(indexed.filter(j => j.sourceType === "protractor")
          .map(j => String(j.servicePackageId).toLowerCase()));
        missing = keys.filter(k => !have.has(k));
        const { canonical, legacy } = evidence.ownership;
        if (receipt?.status === "processing" || receipt?.status === "prior-ambiguous" ||
            (prior && !["imported", "present"].includes(prior.status))) {
          classification = "ambiguous-prior-ingestion";
        } else if (receipt && !["imported", "present", "existing-needs-index-review"].includes(receipt.status)) {
          classification = "held-receipt";
        } else if (canonical.length > 1 || legacy.length > 1 ||
            indexed.some(j => j.sourceType !== "protractor")) {
          classification = "ownership-conflict";
        } else if (keys.some(k => !k) || new Set(keys).size !== keys.length || !keys.length) {
          classification = "insufficient-job-evidence";
        } else if (!canonical.length && !legacy.length) {
          classification = receipt ? "receipt-without-owned-invoice" : "unreceipted-unknown";
        } else {
          classification = missing.length ? "verified-existing-missing-index" : "existing-index-complete";
        }
      } catch {
        // No exception text: database errors may contain payloads or connection details.
        classification = "pre-ingestion-check-failed";
        evidence.checkFailure = "Current ownership/index read failed; historical ingestion outcome unknown";
      }
    }
    rows.push({ ...evidence, classification, missingPackageIds: missing,
      proposedAction: classification === "verified-existing-missing-index"
        ? "approval-required-index-only-review" : "hold-no-replay" });
  }
  for (const receipt of receipts) if (!seenReceipts.has(String(receipt._id))) {
    rows.push({ receiptId: String(receipt._id), receiptStatus: receipt.status, receiptDay: receipt.day,
      classification: "receipt-without-raw-evidence", proposedAction: "hold-no-replay" });
  }
  deadline();
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.classification] = (counts[row.classification] || 0) + 1;
  const orphanReceipts = receipts.length - seenReceipts.size;
  return {
    version: 1, mode: "read-only-preview", scope, startedAt: new Date(started).toISOString(),
    completedAt: new Date().toISOString(), snapshot: "bounded sequential reads; revalidate before any approved repair",
    approvalsRequired: ["production writes", "provider recovery calls", "campaign extensions"],
    prohibitedActions: ["receipt clearing", "checkpoint reset", "financial overwrite", "uncertain ingestion replay"],
    financialReconstruction: "excluded; invoice-hours requires a separate review",
    dayEvidence: scope.days.map(day => ({ day, held: cursor?.heldDays?.includes(day) ?? false,
      archivedPages: pages.filter(p => p.day === day).length,
      checkpoint: days.filter(d => d.day === day).map(d => ({
        terminal: d.terminal, lastPage: d.lastPage, unresolved: d.unresolved })),
      historicalFailureStage: "not persisted; do not infer from held status" })),
    counts: { rawOccurrences, uniqueInvoices: invoices.size, duplicateOccurrences,
      scopedReceipts: receipts.length, matchedScopedReceipts: seenReceipts.size, orphanReceipts,
      reviewed: rows.length, byClassification: counts },
    conservation: { raw: rawOccurrences === invoices.size + duplicateOccurrences,
      receipts: receipts.length === seenReceipts.size + orphanReceipts,
      reviewed: rows.length === invoices.size + orphanReceipts,
      classified: Object.values(counts).reduce((a, b) => a + b, 0) === rows.length },
    rows,
    repairPreview: {
      executable: false,
      candidates: rows.filter(r => r.classification === "verified-existing-missing-index").map(r => ({
        invoiceId: r.invoiceId, receiptId: r.receiptId, sourceDigests: r.sourceDigests,
        pageIds: r.pageIds, ownership: r.ownership, missingPackageIds: r.missingPackageIds,
        operation: "insert-missing-job-index-only",
        prerequisites: ["explicit production approval", "fresh dual-store ownership and receipt checks",
          "preserve existing index rows and all financial fields", "no ingestion or provider replay"],
      })),
    },
  };
}
