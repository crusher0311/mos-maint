import { findShopByShopId } from "@/lib/data/repositories/shops";
import { listUsers } from "@/lib/data/repositories/users";
import { historyEnterprisesForShop, readHistoryPolicy } from "@/lib/data/repositories/vehicle-history-policy";
import { DEFAULT_HISTORY_POLICY, MAX_HISTORY_LOCATIONS } from "./model";

export const historySettingsDependencies = {
  enterprises: historyEnterprisesForShop, shop: findShopByShopId, users: listUsers, policy: readHistoryPolicy,
};

/** Every selected shop must be explicitly assigned to an owner/admin account. */
export async function historySettingsContext(
  email: string, shopId: number, role: string, deps = historySettingsDependencies,
) {
  const matches = await deps.enterprises(shopId);
  const shop = await deps.shop(shopId);
  if (matches.length !== 1 || String(shop?.enterpriseId ?? "") !== matches[0].id) return null;
  const enterprise = matches[0];
  const users = await deps.users({ email });
  const adminIds = new Set<number>();
  for (const user of users) {
    if (!["owner", "admin"].includes(String(user.role)) ||
        user.disabled === true || user.isActive === false || user.deletedAt) continue;
    for (const id of [user.shopId, ...(Array.isArray(user.shopIds) ? user.shopIds : [])]) adminIds.add(Number(id));
  }
  const locations: Array<{ shopId: number; name: string }> = [];
  // Configuration is deliberately capped, not silently truncated.
  if (enterprise.shopIds.length > MAX_HISTORY_LOCATIONS) {
    return { enterpriseId: enterprise.id, policy: DEFAULT_HISTORY_POLICY, locations, canManage: false };
  }
  for (const id of enterprise.shopIds) {
    if (!adminIds.has(id)) continue;
    const member = await deps.shop(id);
    const memberships = await deps.enterprises(id);
    if (String(member?.enterpriseId ?? "") !== enterprise.id ||
        memberships.length !== 1 || memberships[0].id !== enterprise.id) continue;
    locations.push({ shopId: id, name: String(member?.locationIdentifier || member?.name || `Location ${id}`) });
  }
  const policy = await deps.policy(enterprise.id);
  const canManage = ["owner", "admin"].includes(role) && adminIds.has(shopId) &&
    policy.shopIds.filter(id => enterprise.shopIds.includes(id)).every(id => locations.some(l => l.shopId === id));
  return { enterpriseId: enterprise.id, policy, locations, canManage };
}
