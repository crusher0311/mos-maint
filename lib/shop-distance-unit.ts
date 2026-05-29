/**
 * Single source of truth for a shop's distance unit.
 *
 * Background: a shop's odometer/interval unit must follow how its own
 * shop-management integration actually reports mileage — never a value copied
 * or cross-referenced from another shop. Some platforms operate only in markets
 * that report in miles, so a "kilometers" preference on those shops is always a
 * misconfiguration (it understates effective mileage ~38% and inflates VHI
 * health scores). This module encodes that policy so every read/write resolves
 * the unit the same way.
 *
 * Policy:
 *   - Miles-only providers (Tekmetric, Shop-Ware — US-only platforms) ALWAYS
 *     resolve to "miles", regardless of any stored preference.
 *   - Multi-market providers (e.g. Protractor, which serves US + Canada) honor
 *     the shop's explicit `preferences.distanceUnit` (legacy `settings.distanceUnit`).
 *   - Unknown / no provider: honor the stored preference, defaulting to "miles".
 */

export type DistanceUnit = "miles" | "kilometers";

/**
 * Providers that operate exclusively in miles-reporting markets. Their shops
 * can never legitimately be kilometers.
 */
export const MILES_ONLY_PROVIDERS: ReadonlySet<string> = new Set([
  "tekmetric",
  "shopware",
  "shop-ware",
]);

export interface ShopDistanceDoc {
  integrationProvider?: string | null;
  smsProvider?: string | null;
  preferences?: { distanceUnit?: string | null } | null;
  settings?: { distanceUnit?: string | null } | null;
}

/** The canonical integration provider for a shop, lower-cased. */
export function getShopProvider(
  shopDoc: ShopDistanceDoc | null | undefined
): string | null {
  const raw = shopDoc?.integrationProvider ?? shopDoc?.smsProvider ?? null;
  return raw ? String(raw).toLowerCase() : null;
}

/** True when the provider only ever reports odometer readings in miles. */
export function providerIsMilesOnly(provider?: string | null): boolean {
  if (!provider) return false;
  return MILES_ONLY_PROVIDERS.has(String(provider).toLowerCase());
}

/**
 * Whether a given unit may be assigned to a shop on this provider. Used by
 * write paths (settings API, maintenance scripts) to reject illegal units
 * before they ever reach the database.
 */
export function isDistanceUnitAllowed(
  provider: string | null | undefined,
  unit: DistanceUnit
): boolean {
  if (unit === "kilometers" && providerIsMilesOnly(provider)) return false;
  return true;
}

/**
 * Resolve a shop's effective distance unit, enforcing the provider policy.
 * This is the function every consumer should use instead of reading
 * `preferences.distanceUnit` directly.
 */
export function resolveShopDistanceUnit(
  shopDoc: ShopDistanceDoc | null | undefined
): DistanceUnit {
  const provider = getShopProvider(shopDoc);
  if (providerIsMilesOnly(provider)) return "miles";
  const stored =
    shopDoc?.preferences?.distanceUnit ?? shopDoc?.settings?.distanceUnit;
  return stored === "kilometers" ? "kilometers" : "miles";
}
