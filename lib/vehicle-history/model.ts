/** Read evidence only. Never use these identifiers as a provider write context. */
export type SharingStage = "performed" | "deferred" | "reconcile";
export interface HistoryPolicy {
  enabled: boolean;
  stage: SharingStage;
  shopIds: number[];
  revision: number;
}
export interface HistoryComponent {
  key: string;
  action: "replace" | "repair" | "service" | "inspect" | "unknown";
}
export interface HistoryEvent {
  id: string;
  shopId: number;
  location: string;
  provider: string;
  workOrderId: string | null;
  jobId: string;
  title: string;
  date: string | null;
  mileage: number | null;
  mileageUnit: "miles" | "kilometers" | null;
  status: "completed" | "declined" | "unknown";
  origin: string;
  components: HistoryComponent[];
  /** True only when ALL work in a package was identified, not just its title. */
  componentsComplete: boolean;
  readOnly: true;
  resolution?: {
    state: "outstanding" | "partial" | "completed_elsewhere";
    completedBy: string[];
    remainingComponents: string[];
  };
}
export interface HistoryCoverage {
  shopId: number;
  name: string;
  state: "available" | "incomplete" | "unavailable";
  reason?: string;
  hasMore: boolean;
  fetchedAt: string | null;
}
export interface VehicleHistoryView {
  enabled: boolean;
  vin: string | null;
  currentShopId: number;
  policyRevision: string;
  checkedAt: string;
  locations: HistoryCoverage[];
  events: HistoryEvent[];
  reason?: string;
}
export const DEFAULT_HISTORY_POLICY: HistoryPolicy = {
  enabled: false, stage: "performed", shopIds: [], revision: 0,
};
export const MAX_HISTORY_LOCATIONS = 12;
export const MAX_HISTORY_EVENTS = 200;

/** No plates, partial VINs, internal Lookup IDs, or punctuation repair. */
export function normalizeHistoryVin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const vin = value.trim().toUpperCase();
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin) || /^(.)\1+$/.test(vin)) return null;
  return vin;
}

export function eventIdentity(
  shopId: number, provider: string, workOrderId: string | null, jobId: string,
): string {
  return JSON.stringify([shopId, provider, workOrderId, jobId]);
}

export function eventDate(value: unknown): string | null {
  if (!value || (typeof value !== "string" && !(value instanceof Date))) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** Strictly later BUSINESS DAY: date-only sources cannot prove same-day order. */
function later(completion: HistoryEvent, decline: HistoryEvent): boolean {
  return !!completion.date && !!decline.date &&
    completion.date.slice(0, 10) > decline.date.slice(0, 10);
}

/**
 * Event-level, non-destructive reconciliation. No fuzzy title matching or
 * authorization inference. A partial bundle retains every unmatched component.
 */
export function reconcileHistory(events: HistoryEvent[]): HistoryEvent[] {
  const completed = events.filter(e => e.status === "completed" && e.date && e.componentsComplete);
  return events.map(event => {
    if (event.status !== "declined") return event;
    const proofs = new Set<string>();
    const remaining: string[] = [];
    for (const component of event.components) {
      const match = component.action !== "unknown" && component.action !== "inspect"
        ? completed.find(candidate =>
          candidate.shopId !== event.shopId && later(candidate, event) &&
          candidate.components.some(c => c.key === component.key && c.action === component.action))
        : undefined;
      if (match) proofs.add(match.id);
      else remaining.push(`${component.key}:${component.action}`);
    }
    // Incomplete semantic coverage is itself an unresolved part of the bundle.
    if (!event.componentsComplete || !event.components.length) remaining.push("unclassified work");
    return {
      ...event,
      resolution: {
        state: proofs.size === 0 ? "outstanding" : remaining.length ? "partial" : "completed_elsewhere",
        completedBy: [...proofs],
        remainingComponents: remaining,
      },
    };
  });
}

export function validateHistoryPolicy(value: unknown): HistoryPolicy {
  const p = value as HistoryPolicy | null;
  if (!p || typeof p.enabled !== "boolean" ||
      !["performed", "deferred", "reconcile"].includes(p.stage) ||
      !Number.isSafeInteger(p.revision) || p.revision < 0 ||
      !Array.isArray(p.shopIds) || p.shopIds.length > MAX_HISTORY_LOCATIONS ||
      p.shopIds.some(id => !Number.isSafeInteger(id) || id <= 0) ||
      new Set(p.shopIds).size !== p.shopIds.length ||
      (p.enabled && p.shopIds.length < 2)) {
    throw new Error("Invalid sharing policy");
  }
  return { enabled: p.enabled, stage: p.stage, shopIds: [...p.shopIds].sort((a,b) => a-b), revision: p.revision };
}

/** Deduplicate only identical source events. Conflicting mirrors remain unknown. */
export function deduplicateHistory(events: HistoryEvent[]): HistoryEvent[] {
  const byId = new Map<string, HistoryEvent>();
  for (const event of events) {
    const prior = byId.get(event.id);
    if (!prior) byId.set(event.id, event);
    else if (prior.status !== event.status || prior.date !== event.date ||
        prior.title !== event.title || JSON.stringify(prior.components) !== JSON.stringify(event.components)) {
      byId.set(event.id, { ...prior, status: "unknown", componentsComplete: false });
    }
  }
  return [...byId.values()].sort((a,b) => (b.date ?? "").localeCompare(a.date ?? "") || a.id.localeCompare(b.id));
}
