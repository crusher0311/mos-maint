import { reviewDigest, reviewHeldImports, validateReviewScope, type ReviewScope, type ReviewStore } from "./protractor-held-review";
import { extractProtractorServicePackages, getProtractorPackageIdentity, getProtractorPackageLines,
  normalizeProtractorPackageLine, normalizeProtractorServiceJobStatus, summarizeProtractorPackage } from "./integrations/protractor/package-normalization";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export type RepairManifest = {
  version: 1; operation: "insert-missing-job-index-only"; scope: ReviewScope;
  invoiceId: string; evidence: any; packageIds: string[];
};
export type RepairApproval = {
  operation: RepairManifest["operation"]; manifestDigest: string;
  approvedBy: string; approvalReference: string; expiresAt: string;
  writersPaused: true; environment: string;
};
export interface RepairStore extends ReviewStore {
  /** One atomic insert-only batch. No retry after an ambiguous commit. */
  insertOnly(manifest: RepairManifest, rows: any[], revalidate: () => Promise<void>): Promise<void>;
}

async function evidence(store: ReviewStore, scope: ReviewScope, invoiceId: string) {
  const review = await reviewHeldImports(store, scope);
  const row = review.rows.find(r => r.invoiceId === invoiceId);
  if (!row || !["verified-existing-missing-index", "existing-index-complete"].includes(row.classification))
    throw Error("Invoice is not a verified repair candidate");
  const campaign = await store.campaign(scope.campaignId);
  const entry = campaign?.shops?.find((s: any) => s.shopId === scope.shopId);
  const pages = await store.pages(scope);
  if (pages.length > 20 || pages.some(p => p.campaignId !== scope.campaignId ||
      p.shopId !== scope.shopId || !scope.days.includes(p.day) ||
      !Array.isArray(p.invoices) || p.invoices.length > 100 || reviewDigest(p.invoices) !== p.digest))
    throw Error("Archive changed");
  const sources = pages.flatMap(p => p.invoices.filter((i: any) => i.ID?.toLowerCase() === invoiceId));
  if (!sources.length || sources.some(i => reviewDigest(i) !== row.sourceDigests[0]))
    throw Error("Archive changed");
  const receipt = await store.receipt(row.receiptId);
  const prior = entry?.priorJobId ? await store.receipt(`${entry.priorJobId}:${reviewDigest(invoiceId)}`) : null;
  if (receipt && (!["imported", "present", "existing-needs-index-review"].includes(receipt.status) ||
      receipt.sourceDigest !== row.sourceDigests[0] || receipt.shopId !== scope.shopId ||
      receipt.campaignId !== scope.campaignId)) throw Error("Receipt changed");
  if (prior && !["imported", "present"].includes(prior.status)) throw Error("Prior receipt uncertain");
  const ownership = await store.ownership(scope.shopId, invoiceId);
  if (reviewDigest(ownership) !== reviewDigest(row.ownership)) throw Error("Ownership changed");
  return {
    invoice: sources[0], missing: row.missingPackageIds as string[],
    bound: {
      sourceDigest: row.sourceDigests[0],
      pages: pages.map(p => ({ id: String(p._id), digest: p.digest })),
      ownership, receipt: reviewDigest(receipt), prior: reviewDigest(prior),
      campaign: reviewDigest(campaign),
      cursor: reviewDigest(await store.cursor(`${scope.campaignId}:shop:${scope.shopId}`)),
      days: reviewDigest(await store.days(scope)),
    },
  };
}

export async function prepareIndexRepair(store: ReviewStore, scope: ReviewScope, invoiceId: string): Promise<RepairManifest> {
  validateReviewScope(scope);
  if (!UUID.test(invoiceId)) throw Error("Explicit lowercase invoice UUID required");
  const current = await evidence(store, scope, invoiceId);
  if (!current.missing.length) throw Error("No missing packages");
  return { version: 1, operation: "insert-missing-job-index-only", scope, invoiceId,
    evidence: current.bound, packageIds: current.missing };
}

export function validateRepairApproval(manifest: RepairManifest, approval: RepairApproval, environment: string) {
  validateReviewScope(manifest.scope);
  if (manifest.version !== 1 || manifest.operation !== "insert-missing-job-index-only" ||
      !UUID.test(manifest.invoiceId) || !Array.isArray(manifest.packageIds) ||
      !manifest.packageIds.length || manifest.packageIds.length > 1000 ||
      manifest.packageIds.some(k => typeof k !== "string" || !k || k !== k.toLowerCase()) ||
      new Set(manifest.packageIds).size !== manifest.packageIds.length ||
      approval.operation !== manifest.operation || approval.manifestDigest !== reviewDigest(manifest) ||
      !approval.approvedBy?.trim() || !approval.approvalReference?.trim() ||
      approval.writersPaused !== true || !environment || approval.environment !== environment ||
      !Number.isFinite(Date.parse(approval.expiresAt)) || Date.parse(approval.expiresAt) <= Date.now() ||
      Date.parse(approval.expiresAt) > Date.now() + 3600000)
    throw Error("Separate, exact, unexpired index-only approval required (maximum one hour)");
}

/** Pure archive conversion; deliberately no ingestion, enrichment, providers or financial writes. */
export function archivedIndexRows(manifest: RepairManifest, invoice: any, keys: string[]) {
  const date = invoice.Header?.LastModifiedTime || invoice.Header?.CreationTime || invoice.completedAt;
  if (!date || !Number.isFinite(Date.parse(date))) throw Error("Archived service date required");
  const v = invoice.ServiceItem || invoice.vehicle || {};
  const mileage = [invoice.OutUsage, invoice.InUsage, invoice.Odometer, v.Mileage, v.mileage]
    .find(n => typeof n === "number" && n > 0) ?? null;
  return extractProtractorServicePackages(invoice).filter(p =>
    keys.includes(String(getProtractorPackageIdentity(p)).toLowerCase())).map(p => {
    const status = normalizeProtractorServiceJobStatus(p.Status, p._isDeferred === true);
    const lines = getProtractorPackageLines(p).map(normalizeProtractorPackageLine).map(l => {
      const type = l.lineType.toLowerCase();
      return { ...l, lineType: type.includes("labor") ? "labor" :
        /part|material/.test(type) ? "part" : type.includes("sublet") ? "sublet" : "other" };
    });
    const pricing = summarizeProtractorPackage(p);
    const title = p.ServicePackageHeader?.Title || p.Title || p.title;
    const servicePackageId = String(getProtractorPackageIdentity(p)).toLowerCase();
    return {
      _id: `held-index-repair:${reviewDigest([manifest.scope.shopId, manifest.invoiceId, servicePackageId])}`,
      shopId: manifest.scope.shopId, workOrderId: manifest.invoiceId,
      workOrderNumber: invoice.WorkOrderNumber, servicePackageId,
      performedAt: new Date(date), isDeferred: status === "declined" || status === "deferred", mileage,
      vehicle: { vin: v.VIN || v.vin, year: v.Year || v.year, make: v.Make || v.make,
        model: v.Model || v.model, engine: v.Engine || v.engine, serviceItemId: v.ID || v.id, mileage },
      job: { title, description: p.ServicePackageHeader?.Description || p.Description || p.description || "",
        code: p.Code || p.code, chapter: p.Chapter || p.chapter,
        keywords: String(title).toLowerCase().split(/\W+/).filter(Boolean) },
      lines, totals: { laborHours: lines.filter(l => l.lineType.toLowerCase() === "labor").reduce((n, l) => n + l.quantity, 0),
        laborAmount: pricing.laborTotal, partsAmount: pricing.partsTotal, totalAmount: pricing.total },
      metadata: { sourceType: "protractor", indexedAt: new Date(), repairManifestDigest: reviewDigest(manifest) },
    };
  });
}

export async function applyIndexRepair(store: RepairStore, manifest: RepairManifest, approval: RepairApproval, environment: string) {
  validateRepairApproval(manifest, approval, environment);
  const current = await evidence(store, manifest.scope, manifest.invoiceId);
  if (reviewDigest(current.bound) !== reviewDigest(manifest.evidence) ||
      current.missing.some(k => !manifest.packageIds.includes(k))) throw Error("Approved evidence changed; hold");
  const keys = manifest.packageIds.filter(k => current.missing.includes(k));
  if (!keys.length) return { status: "already-present", inserted: 0 } as const;
  const rows = archivedIndexRows(manifest, current.invoice, keys);
  if (rows.length !== keys.length) throw Error("Package conversion mismatch");
  const revalidate = async () => {
    validateRepairApproval(manifest, approval, environment);
    const fresh = await evidence(store, manifest.scope, manifest.invoiceId);
    if (reviewDigest(fresh.bound) !== reviewDigest(manifest.evidence) ||
        reviewDigest(fresh.missing) !== reviewDigest(current.missing))
      throw Error("Concurrent evidence/index change; hold");
  };
  await store.insertOnly(manifest, rows, revalidate);
  return { status: "inserted", inserted: rows.length } as const;
}
