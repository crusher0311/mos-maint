import {
  listAutoflowObservedEventMetadata,
  listAutoflowObservedEventMetadataMongo,
  type AutoflowObservedEventMetadata,
} from "@/lib/data/repositories/events";
import { isIdentityPgCanonical } from "@/lib/db/wave4-write-mode";
import * as pgIdentity from "@/lib/data/repositories/pg/identity";
import {
  defaultAutoflowWorkflowMapping,
  normalizeAutoflowWorkflowStatus,
  validateAutoflowWorkflowMapping,
  type AutoflowWorkflowMapping,
} from "@/lib/autoflow-workflow";
import { getDb } from "@/lib/data/db";
import {
  findShopByShopId,
  listAllShops,
} from "@/lib/data/repositories/shops";
import {
  reserveAutoflowDashboardUpdate,
  finishAutoflowDashboardUpdate,
} from "@/lib/autoflow-dashboard-outbox";

const OBSERVED_LOOKBACK_DAYS = 90;
const MAX_OBSERVED_EVENTS = 5_000;
const MAX_OBSERVED_LABELS = 100;

export const AUTOFLOW_WORKFLOW_BOUNDS = {
  lookbackDays: OBSERVED_LOOKBACK_DAYS,
  maxEvents: MAX_OBSERVED_EVENTS,
  maxLabels: MAX_OBSERVED_LABELS,
} as const;

export interface AutoflowWorkflowShop {
  shopId: string | number;
  name: string;
  autoflowDomain: string | null;
}

export interface ObservedAutoflowStatus {
  label: string;
  count: number;
  lastSeenAt: string | null;
}

export interface AutoflowWorkflowShopDetails {
  shopId: string | number;
  name: string;
  autoflowDomain: string | null;
}

export class InvalidAutoflowWorkflowMappingError extends Error {
  constructor(public readonly revision?: number) {
    super(
      "Stored AutoFlow workflow mapping is invalid; reset it before saving.",
    );
    this.name = "InvalidAutoflowWorkflowMappingError";
  }
}

export class AutoflowWorkflowRevisionConflictError extends Error {
  constructor() {
    super("Another admin changed this shop's workflow settings. Reload the latest settings and review them alongside your edits before saving again.");
    this.name = "AutoflowWorkflowRevisionConflictError";
  }
}
/**
 * Repository seams keep the route and offline smoke tests independent of both
 * databases. In production these point at the normal storage-mode-aware shop
 * repository and the PG-canonical event reader.
 */
export const __deps = {
  getDb,
  listAllShops,
  findShopByShopId,
  isIdentityPgCanonical,
  replacePgWorkflowIfRevision: pgIdentity.replaceAutoflowWorkflowIfRevision,
  listObservedAutoflowEvents: listAutoflowObservedEventMetadata,
  listObservedAutoflowEventsMongo: listAutoflowObservedEventMetadataMongo,
  reserveAutoflowDashboardUpdate,
  finishAutoflowDashboardUpdate,
};

function sameShop(a: unknown, b: unknown): boolean {
  return String(a) === String(b);
}

function connectedAutoflowShop(shop: any): boolean {
  return Boolean(
    shop?.autoflow?.domain ||
      shop?.autoflow?.subdomain ||
      shop?.autoflow?.shopId != null ||
      shop?.autoflow?.configured ||
      shop?.autoflow?.apiKey ||
      shop?.autoflowApiKey ||
      shop?.autoflowDomain ||
      (Array.isArray(shop?.autoflow?.shopNumbers) &&
        shop.autoflow.shopNumbers.length > 0),
  );
}

function domainFor(shop: any): string | null {
  return (
    shop?.autoflow?.domain ||
    shop?.autoflowDomain ||
    shop?.autoflow?.subdomain ||
    null
  );
}

function toWorkflowShop(shop: any): AutoflowWorkflowShop {
  return {
    shopId: shop.shopId,
    name: shop.name || `Shop ${shop.shopId}`,
    autoflowDomain: domainFor(shop),
  };
}

function mappingFor(shop: any): AutoflowWorkflowMapping | null {
  const candidate = shop?.autoflow?.workflowMapping;
  if (candidate == null) return null;
  try {
    return validateAutoflowWorkflowMapping(candidate);
  } catch {
    throw new InvalidAutoflowWorkflowMappingError(revisionFor(shop));
  }
}

function eventStatus(event: AutoflowObservedEventMetadata): string | null {
  const value = event.status ?? event.type;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function eventDate(event: AutoflowObservedEventMetadata): Date | null {
  const value = event.receivedAt || event.createdAt;
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function observedStatuses(
  shopId: string | number,
): Promise<ObservedAutoflowStatus[]> {
  const since = new Date(
    Date.now() - OBSERVED_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  );
  const [pgResult, mongoResult] = await Promise.allSettled([
    __deps.listObservedAutoflowEvents(shopId, {
      since,
      limit: MAX_OBSERVED_EVENTS,
    }),
    __deps.listObservedAutoflowEventsMongo(shopId, {
      since,
      limit: MAX_OBSERVED_EVENTS,
    }),
  ]);
  if (pgResult.status === "rejected" || mongoResult.status === "rejected") {
    // Do not present an incomplete discovery result as a successful review:
    // legacy events may exist only in Mongo, newer events only in PG.
    throw new Error("AutoFlow workflow discovery is temporarily unavailable");
  }
  const events = [
    ...(pgResult.status === "fulfilled" ? pgResult.value : []),
    ...(mongoResult.status === "fulfilled" ? mongoResult.value : []),
  ].filter((event) => sameShop(event.shopId, shopId));
  const dedupedEvents = new Map<string, AutoflowObservedEventMetadata>();
  for (const event of events) {
    const receivedAt = event.receivedAt
      ? new Date(event.receivedAt).toISOString()
      : "";
    const createdAt = event.createdAt
      ? new Date(event.createdAt).toISOString()
      : "";
    const key = [
      event.shopId,
      normalizeAutoflowWorkflowStatus(event.status || event.type),
      event.type || "",
      receivedAt,
      createdAt,
    ].join("|");
    if (!dedupedEvents.has(key)) dedupedEvents.set(key, event);
  }

  const byKey = new Map<
    string,
    { label: string; count: number; lastSeenAt: Date | null }
  >();
  for (const event of [...dedupedEvents.values()]
    .sort((a, b) => (eventDate(b)?.getTime() || 0) - (eventDate(a)?.getTime() || 0))
    .slice(
    0,
    MAX_OBSERVED_EVENTS,
  )) {
    const label = eventStatus(event);
    if (!label) continue;
    const key = normalizeAutoflowWorkflowStatus(label);
    const date = eventDate(event);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { label, count: 1, lastSeenAt: date });
    } else {
      existing.count += 1;
      if (
        date &&
        (!existing.lastSeenAt || date.getTime() > existing.lastSeenAt.getTime())
      ) {
        existing.lastSeenAt = date;
      }
    }
  }

  return [...byKey.values()]
    .sort((a, b) => {
      const dateDiff =
        (b.lastSeenAt?.getTime() || 0) - (a.lastSeenAt?.getTime() || 0);
      return dateDiff || a.label.localeCompare(b.label);
    })
    .slice(0, MAX_OBSERVED_LABELS)
    .map((item) => ({
      label: item.label,
      count: item.count,
      lastSeenAt: item.lastSeenAt?.toISOString() || null,
    }));
}

export async function listAutoflowWorkflowShops(): Promise<
  AutoflowWorkflowShop[]
> {
  const shops = await __deps.listAllShops();
  return shops
    .filter(connectedAutoflowShop)
    .map(toWorkflowShop)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function findAutoflowWorkflowShop(
  shopId: string | number,
): Promise<(AutoflowWorkflowShopDetails & { mapping: AutoflowWorkflowMapping | null; revision: number; source: any }) | null> {
  const shop = await __deps.findShopByShopId(shopId);
  if (!shop || !connectedAutoflowShop(shop)) return null;
  return {
    ...toWorkflowShop(shop),
    revision: revisionFor(shop),
    mapping: mappingFor(shop),
    source: shop,
  };
}

async function findAutoflowWorkflowShopRecord(shopId: string | number) {
  const shop = await __deps.findShopByShopId(shopId);
  return shop && connectedAutoflowShop(shop) ? shop : null;
}

export async function getAutoflowWorkflowDetails(shopId: string | number) {
  const shop = await findAutoflowWorkflowShop(shopId);
  if (!shop) return null;
  return {
    shop: {
      shopId: shop.shopId,
      name: shop.name,
    },
    mapping: shop.mapping,
    revision: shop.revision,
    observed: await observedStatuses(shop.shopId),
    bounds: AUTOFLOW_WORKFLOW_BOUNDS,
  };
}

/**
 * Read the effective persisted mapping through the active identity storage
 * mode. A null result means the shop has not opted into custom mapping and
 * callers should apply the legacy defaults.
 */
export async function getAutoflowWorkflowMapping(
  shopId: string | number,
): Promise<AutoflowWorkflowMapping | null> {
  const shop = await __deps.findShopByShopId(shopId);
  if (!shop) return null;
  const candidate = (shop as any)?.autoflow?.workflowMapping;
  if (candidate == null) return null;
  // Dashboard reads must not silently replace a malformed explicit mapping
  // with fleet defaults; surface it to the caller for an operator fix.
  try {
    return validateAutoflowWorkflowMapping(candidate);
  } catch {
    throw new InvalidAutoflowWorkflowMappingError();
  }
}

async function withDashboardNotification(
  shopId: string | number,
  persist: () => Promise<void>,
): Promise<string | undefined> {
  // Write-ahead reservation closes the cross-store gap in BOTH identity modes.
  // If reserving fails, do not change settings; once reserved, notification
  // failure must not turn a successful save/reset into a manual-retry error.
  const db = await __deps.getDb();
  const notificationId = await __deps.reserveAutoflowDashboardUpdate(
    db, shopId, "autoflow_workflow",
  );
  let warning: string | undefined;
  try {
    await persist();
  } finally {
    // Even a failed/ambiguous write may have committed; conservative
    // invalidation is safe, whereas replaying the settings mutation is not.
    try {
      await __deps.finishAutoflowDashboardUpdate(db, notificationId);
    } catch {
      // Never mask a CAS conflict or report an already committed revision as
      // a failed write. The prepared intent remains available for recovery.
      console.warn("[AutoFlow Workflow] Dashboard notification deferred");
      warning = "Workflow settings saved, but open dashboards could not be notified immediately. A retry is queued; refresh the dashboard to see the changes.";
    }
  }
  return warning;
}

export async function saveAutoflowWorkflow(
  shopId: string | number,
  value: unknown,
  expectedRevision: number,
) {
  const mapping = validateAutoflowWorkflowMapping(value);
  return replaceWorkflow(shopId, mapping, expectedRevision);
}
export async function resetAutoflowWorkflow(
  shopId: string | number,
  expectedRevision: number,
) {
  return replaceWorkflow(shopId, null, expectedRevision);
}

async function replaceWorkflow(
  shopId: string | number,
  mapping: AutoflowWorkflowMapping | null,
  expectedRevision: number,
) {
  if (!isValidAutoflowWorkflowRevision(expectedRevision)) {
    throw new Error("expectedRevision must be a non-negative safe integer");
  }
  const shop = await findAutoflowWorkflowShopRecord(shopId);
  if (!shop) throw new Error("AutoFlow shop not found");

  const warning = await withDashboardNotification(shop.shopId, async () => {
    let matchedCount: number;
    if (__deps.isIdentityPgCanonical()) {
      ({ matchedCount } = await __deps.replacePgWorkflowIfRevision(
        shop.shopId, mapping, expectedRevision,
      ));
    } else {
      const db = await __deps.getDb();
      const revisionFilter = expectedRevision === 0
        ? { $or: [
            { "autoflow.workflowRevision": 0 },
            { "autoflow.workflowRevision": null },
          ] }
        : { "autoflow.workflowRevision": expectedRevision };
      ({ matchedCount } = await db.collection("shops").updateOne({
        $and: [
          { $or: [{ shopId: Number(shop.shopId) }, { shopId: String(shop.shopId) }] },
          revisionFilter,
        ],
      }, {
        $set: {
          "autoflow.workflowMapping": mapping,
          "autoflow.workflowRevision": expectedRevision + 1,
          updatedAt: new Date(),
        },
      }));
    }
    if (matchedCount !== 1) throw new AutoflowWorkflowRevisionConflictError();
  });
  return { mapping, revision: expectedRevision + 1, ...(warning ? { warning } : {}) };
}

export { defaultAutoflowWorkflowMapping };

export function isValidAutoflowWorkflowRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 0 && value < Number.MAX_SAFE_INTEGER;
}

function revisionFor(shop: any): number {
  const revision = shop?.autoflow?.workflowRevision ?? 0;
  if (!isValidAutoflowWorkflowRevision(revision)) {
    throw new Error("Stored AutoFlow workflow revision is invalid");
  }
  return revision;
}
