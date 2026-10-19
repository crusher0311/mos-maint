import { findShopByShopId } from "@/lib/data/repositories/shops";
import { historyEnterprisesForShop } from "@/lib/data/repositories/vehicle-history-policy";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import { listUsers } from "@/lib/data/repositories/users";
import { readShopProtractorCredentials } from "@/lib/integrations/protractor/shop-eligibility";

export const authorizationDependencies = {
  shop: findShopByShopId, enterprises: historyEnterprisesForShop,
  entitlements: getFeatureEntitlements, users: listUsers,
};
/** Redistribution is NOT employee history access. Require current management
 * authority, unambiguous ownership, explicit selection and current entitlements. */
export async function authorizeManager(session: any, enterpriseId: string, deps = authorizationDependencies) {
  if (!session || session.isImpersonation) throw new Error("Permission denied");
  if (session.isPlatformAdmin || session.role === "platform_admin") return;
  if (!["owner", "admin", "enterprise_admin"].includes(session.role)) throw new Error("Permission denied");
  const shop = await deps.shop(Number(session.shopId));
  const memberships = await deps.enterprises(Number(session.shopId));
  if (!shop || String(shop.enterpriseId) !== enterpriseId || memberships.length !== 1 ||
      memberships[0].id !== enterpriseId) throw new Error("Permission denied");
  const users = await deps.users({ email: session.email });
  if (!users.some(u => ["owner", "admin", "enterprise_admin"].includes(String(u.role)) &&
      !u.disabled && u.isActive !== false && !u.deletedAt &&
      [u.shopId, ...(Array.isArray(u.shopIds) ? u.shopIds : [])].map(Number).includes(Number(session.shopId))))
    throw new Error("Permission denied");
}
export async function authorizeShop(enterpriseId: string, shopId: number, deps = authorizationDependencies) {
  const shop = await deps.shop(shopId);
  const memberships = await deps.enterprises(shopId);
  if (!shop || String(shop.enterpriseId) !== enterpriseId || memberships.length !== 1 ||
      memberships[0].id !== enterpriseId || !memberships[0].shopIds.includes(shopId))
    throw new Error("shop_ownership_changed");
  const s = shop as any;
  if (!readShopProtractorCredentials(s)) throw new Error("protractor_disconnected");
  if (s.status === "canceled" || s.status === "cancelled" || s.locked === true ||
      s.isLocked === true || ["canceled", "cancelled", "suspended"].includes(s.billing?.status)) throw new Error("shop_not_active");
  const entitlement = await deps.entitlements(shopId, { throwIfMissing: true });
  if (!entitlement.effectiveFeatures.maintenance) throw new Error("shop_not_entitled");
  return { shopId, name: String(s.name || `Shop ${shopId}`) };
}
