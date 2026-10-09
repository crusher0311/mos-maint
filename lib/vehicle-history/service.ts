import { createHash } from "node:crypto";
import { findShopByShopId } from "@/lib/data/repositories/shops";
import { listUsers } from "@/lib/data/repositories/users";
import {
  historyEnterprisesForShop, readHistoryPolicy,
} from "@/lib/data/repositories/vehicle-history-policy";
import { readVehicleHistoryLocation } from "@/lib/data/repositories/vehicle-history";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import { historyBudget } from "./budget";
import {
  DEFAULT_HISTORY_POLICY, MAX_HISTORY_LOCATIONS, deduplicateHistory,
  normalizeHistoryVin, reconcileHistory, validateHistoryPolicy,
  type HistoryPolicy, type VehicleHistoryView,
} from "./model";

export interface HistoryPrincipal {
  currentShopId: number;
  email: string;
  channel: "dashboard" | "extension" | "partner" | "signed";
  /** Only authenticated account identities, never basic/anonymous principals. */
  verified: boolean;
}

export const historyDependencies = {
  enterprises: historyEnterprisesForShop,
  policy: readHistoryPolicy,
  shop: findShopByShopId,
  users: listUsers,
  entitlements: getFeatureEntitlements,
  read: readVehicleHistoryLocation,
  enabled: () => process.env.ENTERPRISE_VEHICLE_HISTORY_ENABLED === "1",
};
type Dependencies = typeof historyDependencies;
export interface HistoryScope {
  enterpriseId: string | null;
  policy: HistoryPolicy;
  locations: Array<{ shopId: number; name: string }>;
  fingerprint: string;
  reason?: string;
}
const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * Fresh scope for every read (and again before returning). This grants no
 * provider action capability and never modifies the request's current shop.
 */
export async function resolveHistoryScope(
  principal: HistoryPrincipal, deps: Dependencies = historyDependencies,
): Promise<HistoryScope> {
  const denied = (reason: string): HistoryScope => ({
    enterpriseId: null, policy: { ...DEFAULT_HISTORY_POLICY, shopIds: [] },
    locations: [], fingerprint: fingerprint([principal.currentShopId, reason]), reason,
  });
  if (!deps.enabled()) return denied("Cross-location history is not enabled.");
  // No cross-location redistribution via partner keys or public report tokens.
  if (!principal.verified || !principal.email ||
      !["dashboard", "extension"].includes(principal.channel)) return denied("This channel is local-only.");
  const enterpriseMatches = await deps.enterprises(principal.currentShopId);
  if (enterpriseMatches.length !== 1) return denied("Enterprise membership is missing or ambiguous.");
  const enterprise = enterpriseMatches[0];
  const current = await deps.shop(principal.currentShopId);
  if (!current || String(current.enterpriseId ?? "") !== enterprise.id) {
    return denied("Enterprise membership is inconsistent.");
  }
  const policy = validateHistoryPolicy(await deps.policy(enterprise.id));
  if (!policy.enabled || !policy.shopIds.includes(principal.currentShopId)) return denied("Sharing is disabled for this location.");
  if (policy.shopIds.length > MAX_HISTORY_LOCATIONS) return denied("Sharing scope exceeds the supported limit.");
  // Model B explicit assignments only. Never widen by role or enterprise alone.
  const users = await deps.users({ email: principal.email });
  const allowed = new Set<number>();
  for (const user of users) {
    if (user.disabled === true || user.isActive === false || user.deletedAt) continue;
    for (const id of [user.shopId, ...(Array.isArray(user.shopIds) ? user.shopIds : [])]) {
      if (Number.isSafeInteger(Number(id)) && Number(id) > 0) allowed.add(Number(id));
    }
  }
  if (!allowed.has(principal.currentShopId)) return denied("Current location access was removed.");
  const locations: HistoryScope["locations"] = [];
  // Serial metadata reads keep DB pressure bounded independently of fleet size.
  for (const shopId of policy.shopIds) {
    if (!allowed.has(shopId) || !enterprise.shopIds.includes(shopId)) continue;
    const membership = await deps.enterprises(shopId);
    if (membership.length !== 1 || membership[0].id !== enterprise.id) continue;
    const shop = await deps.shop(shopId);
    if (!shop || String(shop.enterpriseId ?? "") !== enterprise.id) continue;
    const entitlement = await deps.entitlements(shopId, { throwIfMissing: true });
    if (!entitlement.effectiveFeatures.maintenance) continue;
    locations.push({ shopId, name: String(shop.locationIdentifier || shop.name || `Location ${shopId}`) });
  }
  if (!locations.some(l => l.shopId === principal.currentShopId)) return denied("Current location is not entitled to shared history.");
  return {
    enterpriseId: enterprise.id, policy, locations,
    fingerprint: fingerprint([principal.channel, principal.currentShopId, enterprise.id, policy, locations]),
  };
}

export async function readEnterpriseVehicleHistory(
  principal: HistoryPrincipal, inputVin: unknown, deps: Dependencies = historyDependencies,
): Promise<VehicleHistoryView> {
  const budget = historyBudget();
  // Every authorization read shares the SAME deadline, not 8 seconds each.
  const scopedDeps: Dependencies = {
    ...deps,
    enterprises: (...args) => budget(() => deps.enterprises(...args)),
    policy: (...args) => budget(() => deps.policy(...args)),
    shop: (...args) => budget(() => deps.shop(...args)),
    users: (...args) => budget(() => deps.users(...args)),
    entitlements: (...args) => budget(() => deps.entitlements(...args)),
    read: (...args) => budget(() => deps.read(...args)),
  };
  const vin = normalizeHistoryVin(inputVin);
  const empty: VehicleHistoryView = {
    enabled: false, vin, currentShopId: principal.currentShopId, policyRevision: "",
    checkedAt: new Date().toISOString(), locations: [], events: [],
  };
  if (!vin) return { ...empty, reason: "A valid, complete VIN is required. Local records have not been linked." };
  const scope = await resolveHistoryScope(principal, scopedDeps);
  if (!scope.policy.enabled) return { ...empty, policyRevision: scope.fingerprint, reason: scope.reason };
  const events: VehicleHistoryView["events"] = [];
  const locations: VehicleHistoryView["locations"] = [];
  // Two lanes maximum, no unbounded Promise.all fleet fanout.
  const queue = [...scope.locations];
  const lane = async () => {
    for (;;) {
      const location = queue.shift();
      if (!location) return;
      try {
        const result = await scopedDeps.read(location.shopId, vin, location.name);
        events.push(...result.events.filter(e => e.shopId === location.shopId));
        locations.push(result.coverage);
      } catch {
        locations.push({
          ...location, state: "unavailable", hasMore: false, fetchedAt: null,
          reason: "Location history could not be read. This does not mean no work was recorded.",
        });
      }
    }
  };
  await Promise.all([lane(), lane()]);
  // Scope revoked during a slow DB query: discard the entire result.
  const finalScope = await resolveHistoryScope(principal, scopedDeps);
  if (scope.fingerprint !== finalScope.fingerprint) {
    return { ...empty, reason: "Sharing access changed. Refresh to load the current scope." };
  }
  let visible = deduplicateHistory(events);
  if (scope.policy.stage === "performed") visible = visible.filter(e => e.status === "completed");
  if (scope.policy.stage === "reconcile") visible = reconcileHistory(visible);
  return {
    ...empty, enabled: true, checkedAt: new Date().toISOString(),
    policyRevision: scope.fingerprint, locations: locations.sort((a,b) => a.shopId-b.shopId),
    events: visible,
  };
}
