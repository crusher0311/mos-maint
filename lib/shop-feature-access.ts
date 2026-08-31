import type { FeatureEntitlements, FeatureKey } from "./featureResolver";

export interface ShopFeatureSession {
  isPlatformAdmin?: boolean;
  isImpersonation?: boolean;
}

export const AUTO_DVI_REQUIRED_FEATURES: FeatureKey[] = ["maintenance", "auto_dvi"];

export function canPlatformAdminBypassShopFeatures(session: ShopFeatureSession): boolean {
  return session.isPlatformAdmin === true && session.isImpersonation !== true;
}

/**
 * Platform admins may inspect shop product pages from their own session, but
 * impersonation must always resolve exactly like the target shop.
 */
export function canAccessShopFeature(
  session: ShopFeatureSession,
  entitlements: FeatureEntitlements,
  feature: FeatureKey,
): boolean {
  if (canPlatformAdminBypassShopFeatures(session)) return true;
  return entitlements.canUseFeature(feature);
}