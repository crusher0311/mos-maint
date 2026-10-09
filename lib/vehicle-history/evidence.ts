import {
  eventDate, eventIdentity, type HistoryComponent, type HistoryEvent,
} from "./model";
import { getProtractorPackageLines, unwrapProtractorCollection } from "@/lib/integrations/protractor/package-normalization";

/**
 * Intentionally small exact grammar. A title not fully described by this
 * vocabulary is visible but cannot silently settle deferred work.
 */
const COMPONENTS: Record<string, string> = {
  "engine oil and filter": "engine_oil_filter",
  "engine oil filter": "engine_oil_filter",
  "engine air filter": "engine_air_filter",
  "cabin air filter": "cabin_air_filter",
  "spark plugs": "spark_plugs",
  "brake fluid": "brake_fluid",
  "engine coolant": "engine_coolant",
  "transmission fluid": "transmission_fluid",
  "front brake pads": "front_brake_pads",
  "rear brake pads": "rear_brake_pads",
  "front brake rotors": "front_brake_rotors",
  "rear brake rotors": "rear_brake_rotors",
  "timing belt": "timing_belt",
  "serpentine belt": "serpentine_belt",
  "water pump": "water_pump",
};

export function classifyComponents(title: string): { components: HistoryComponent[]; complete: boolean } {
  const parts = title.trim().toLowerCase().split(/\s*(?:;|\+)\s*/);
  const components: HistoryComponent[] = [];
  let complete = parts.length > 0;
  for (const part of parts) {
    const match = /^(replace|repair|service|inspect)\s+(.+?)\.?$/.exec(part);
    const key = match && COMPONENTS[match[2]];
    if (match && key) components.push({ key, action: match[1] as HistoryComponent["action"] });
    else complete = false;
  }
  return { components, complete };
}

/** A package title alone cannot prove that all of a bundle was completed. */
export function classifyPackage(title: string, raw: any) {
  const titleResult = classifyComponents(title);
  const rawLines = Array.isArray(raw?.lines) ? raw.lines
    : Array.isArray(raw?.labor) ? raw.labor
    : Array.isArray(raw?.labors) ? raw.labors
    : getProtractorPackageLines(raw);
  const labor = rawLines.filter((line: any) => {
    const type = String(line.lineType || line.Type || line.type || "").toLowerCase();
    return !type || ["labor", "labour", "service", "sublet"].includes(type);
  });
  const results = labor.map((line: any) => classifyComponents(
    String(line.description || line.Description || line.name || line.Name || ""),
  ));
  const lineComponents: HistoryComponent[] = results.flatMap((r: ReturnType<typeof classifyComponents>) => r.components);
  const components = [...titleResult.components, ...lineComponents];
  const classified: HistoryComponent[] = [];
  for (const key of new Set(components.map(c => c.key))) {
    const actions = new Set(components.filter(c => c.key === key).map(c => c.action));
    const lineActions = lineComponents.filter(c => c.key === key).map(c => c.action);
    // A title is a request/summary, not evidence that the stated action was
    // performed. Require a corresponding labor action, with no contradictory
    // action anywhere else in the title or labor evidence.
    const action = actions.size === 1 && lineActions.length > 0
      ? [...actions][0] : "unknown";
    classified.push({ key, action });
  }
  return {
    components: classified,
    complete: titleResult.complete && labor.length > 0 &&
      classified.every(c => c.action !== "unknown") &&
      results.every((r: ReturnType<typeof classifyComponents>) => r.complete),
  };
}

export function explicitJobStatus(raw: any): HistoryEvent["status"] {
  const statuses = [raw?.status, raw?.Status, raw?.jobStatus]
    .filter(s => typeof s === "string").map(s => s.trim().toLowerCase());
  // Negative evidence beats any accidental positive flag.
  if (raw?.authorized === false || raw?._isDeferred === true ||
      statuses.some(s => ["declined", "deferred", "cancelled", "canceled"].includes(s))) {
    return statuses.some(s => ["cancelled", "canceled"].includes(s)) ? "unknown" : "declined";
  }
  if (statuses.some(s => ["completed", "complete", "performed"].includes(s))) return "completed";
  return "unknown";
}

export interface NormalizedHistoryRow {
  shop_id: number; provider: string; work_order_id: string; work_order_number: string;
  job_id: string; job_number: string | null; job_provenance: any;
  title: string; job_type: string; job_status: string; job_raw: any;
  declined_at: unknown; completed_at: unknown; closed_date: unknown;
  odometer: number | null; odometer_unit: string;
  work_order_raw?: any; work_order_provenance?: any;
}

export function normalizedHistoryEvent(row: NormalizedHistoryRow, location: string): HistoryEvent {
  const provider = row.provider || "unknown";
  const sourceIds = Array.isArray(row.job_provenance?.sourceIds) ? row.job_provenance.sourceIds : [];
  const sourceId = sourceIds.find((s: any) => s.system === provider && s.isPrimary === true);
  const jobId = String(sourceId?.idValue || row.job_number || row.job_id);
  // raw_data on normalized jobs is the normalized doc, NOT a provider receipt.
  // Recover the original package from the preserved WO payload by exact ID.
  const receipt = row.work_order_raw?.rawPayload;
  let candidates: any[] = [];
  if (provider === "tekmetric") candidates = Array.isArray(receipt?.jobs) ? receipt.jobs : [];
  if (provider === "shopmonkey") candidates = Array.isArray(receipt?.services) ? receipt.services : [];
  if (provider === "shopware") candidates = Array.isArray(receipt?.services) ? receipt.services : [];
  if (provider === "protractor") {
    candidates = [
      ...unwrapProtractorCollection(receipt?.ServicePackages),
      ...unwrapProtractorCollection(receipt?.DeferredServicePackages).map((r: any) => ({ ...r, _isDeferred: true })),
    ];
  }
  const matches = candidates.filter(c => String(c.ID ?? c.id ?? c.ServicePackageHeader?.ID ?? "") === jobId);
  const raw = matches.length === 1 ? matches[0] : {};
  const woSources = Array.isArray(row.work_order_provenance?.sourceIds) ? row.work_order_provenance.sourceIds : [];
  const woSource = woSources.find((s: any) => s.system === provider && s.isPrimary === true);
  const workOrderId = String(woSource?.idValue || row.work_order_id);
  let status = explicitJobStatus(raw);
  // The stored enum can provide negative evidence, but never positive proof:
  // some historical adapters defaulted unknown jobs to "completed".
  if (["declined", "deferred"].includes(row.job_status)) status = "declined";
  if (row.job_status === "cancelled") status = "unknown";
  if (row.job_type === "inspection") status = "unknown";
  const semantic = classifyPackage(row.title, raw);
  // Do not use import time, LastModifiedTime, or header CreationTime.
  const date = status === "declined"
    ? eventDate(raw.declinedAt || raw.declinedDate || row.declined_at)
    : eventDate(raw.completedAt || raw.completedDate || raw.CompletedDate ||
        receipt?.postedDate || receipt?.closedDate || receipt?.InvoiceTime || receipt?.InvoiceDate);
  return {
    id: eventIdentity(row.shop_id, provider, workOrderId, jobId),
    shopId: row.shop_id, location, provider, workOrderId,
    jobId, title: row.title, date, mileage: row.odometer,
    mileageUnit: row.odometer_unit === "miles" || row.odometer_unit === "kilometers" ? row.odometer_unit : null,
    status, origin: "normalized", components: semantic.components,
    componentsComplete: semantic.complete, readOnly: true,
  };
}

export function deferredSnapshotEvent(
  item: any, index: number, shopId: number, location: string, provider: string,
): HistoryEvent {
  const title = String(item.title || item.Title || item.ServicePackageHeader?.Title || "Deferred work");
  const jobId = String(item.id || item.ID || `snapshot-item-${index}`);
  const wo = item.originalWorkOrderId ? String(item.originalWorkOrderId) : null;
  const semantic = classifyPackage(title, item);
  return {
    id: eventIdentity(shopId, provider, wo, wo ? jobId : `deferred:${jobId}`),
    shopId, location, provider, workOrderId: wo, jobId, title,
    date: eventDate(item.date || item.declinedAt || item.DeferredDate),
    mileage: typeof item.mileage === "number" ? item.mileage : null,
    mileageUnit: item.mileageUnit === "miles" || item.mileageUnit === "kilometers" ? item.mileageUnit : null,
    status: "declined", origin: "provider_snapshot",
    components: semantic.components, componentsComplete: semantic.complete, readOnly: true,
  };
}
