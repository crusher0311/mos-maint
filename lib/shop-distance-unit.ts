/**
 * Single source of truth for a shop's distance unit.
 *
 * Background: a shop's odometer/interval unit must follow how its own
 * shop-management integration actually reports mileage — never a value copied
 * or cross-referenced from another shop. The unit a shop reports in is a
 * function of WHERE the shop is: US shops report miles, Canadian shops report
 * kilometers. A wrong unit understates/overstates effective mileage ~38% and
 * skews VHI health scores, so we resolve the unit the same way everywhere.
 *
 * Policy (in priority order):
 *   0. Explicit owner override wins. An owner may DELIBERATELY choose their unit
 *      in shop settings. We record that intent as `preferences.distanceUnitSource
 *      = "owner"`; when that flag is present the saved `preferences.distanceUnit`
 *      is honored above everything else. Crucially, only this explicit flag
 *      counts — a bare/legacy `preferences.distanceUnit` left over from an old
 *      import or a script mislabel does NOT qualify, so the historical bad values
 *      can't masquerade as an intentional override.
 *   1. Known country. If we know the shop's country (from its integration's
 *      address — see `resolveShopCountry`), the unit is derived from it:
 *      Canada -> kilometers, US -> miles. This is the smart default that, absent
 *      an owner override, keeps a stray "kilometers" on a US shop (or "miles" on
 *      a Canadian shop) from inflating/deflating scores.
 *   2. Unknown country on a single-market provider. Providers that operate in
 *      exactly one metric market (`MILES_ONLY_PROVIDERS`) fall back to that
 *      market's unit (miles) until their country is backfilled. This is the
 *      safe default that prevents score inflation for not-yet-geocoded shops.
 *      NOTE: Tekmetric and Shop-Ware predominantly serve the US but Tekmetric
 *      DOES have Canadian shops — those are handled by rule 1 once their country
 *      is known (see scripts/backfill-tekmetric-shop-country.ts).
 *   3. Unknown country, other providers (e.g. Protractor): honor the shop's
 *      stored `preferences.distanceUnit` (legacy `settings.distanceUnit`),
 *      defaulting to "miles".
 */

export type DistanceUnit = "miles" | "kilometers";
export type ShopCountry = "US" | "CA";

/** Marks a `preferences.distanceUnit` value as a deliberate owner choice. */
export const OWNER_UNIT_SOURCE = "owner";

/**
 * Providers that PREDOMINANTLY operate in a miles-reporting market. Used only as
 * a fallback when a shop's actual country is not yet known. A shop on one of
 * these providers can still be kilometers if its country is confirmed to be
 * Canada (rule 1 in `resolveShopDistanceUnit`).
 */
export const MILES_ONLY_PROVIDERS: ReadonlySet<string> = new Set([
  "tekmetric",
  "shopware",
  "shop-ware",
]);

/** Canadian province / territory two-letter codes. */
export const CA_PROVINCES: ReadonlySet<string> = new Set([
  "AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT",
]);

/** US state / territory two-letter codes (incl. DC + common territories). */
export const US_STATES: ReadonlySet<string> = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL",
  "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT",
  "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI",
  "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  "DC", "PR", "VI", "GU", "AS", "MP",
]);

/** Canadian postal code: A1A 1A1 (letter-digit-letter [space] digit-letter-digit). */
const CA_POSTAL = /^[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d$/;
/** US ZIP: 5 digits, optional +4. */
const US_ZIP = /^\d{5}(-\d{4})?$/;

export interface ShopGeo {
  country?: string | null;
  state?: string | null;
  zip?: string | null;
}

export interface ShopDistanceDoc {
  integrationProvider?: string | null;
  smsProvider?: string | null;
  preferences?: {
    distanceUnit?: string | null;
    /** "owner" when the saved unit is a deliberate owner choice (see policy). */
    distanceUnitSource?: string | null;
  } | null;
  settings?: { distanceUnit?: string | null } | null;
  /** Backfilled location, e.g. from the integration's shop address. */
  geo?: ShopGeo | null;
}

/** Normalize a free-form unit string to a canonical `DistanceUnit`, or null. */
export function normalizeDistanceUnit(
  unit: string | null | undefined
): DistanceUnit | null {
  if (!unit) return null;
  const u = String(unit).trim().toLowerCase();
  if (u === "kilometers" || u === "kilometres" || u === "km") return "kilometers";
  if (u === "miles" || u === "mi") return "miles";
  return null;
}

/**
 * The unit an owner has DELIBERATELY chosen, or null if there is no explicit
 * override. Only `preferences.distanceUnitSource === "owner"` counts — a bare
 * `preferences.distanceUnit` (legacy import / script value) does NOT, so old bad
 * values can't impersonate an intentional override.
 */
export function getOwnerUnitOverride(
  shopDoc: ShopDistanceDoc | null | undefined
): DistanceUnit | null {
  const src = shopDoc?.preferences?.distanceUnitSource;
  if (src && String(src).trim().toLowerCase() === OWNER_UNIT_SOURCE) {
    return normalizeDistanceUnit(shopDoc?.preferences?.distanceUnit);
  }
  return null;
}

/** The canonical integration provider for a shop, lower-cased. */
export function getShopProvider(
  shopDoc: ShopDistanceDoc | null | undefined
): string | null {
  const raw = shopDoc?.integrationProvider ?? shopDoc?.smsProvider ?? null;
  return raw ? String(raw).toLowerCase() : null;
}

/**
 * True when the provider only ever reports in miles in the markets it serves.
 * Used only as a fallback for shops whose actual country is unknown.
 */
export function providerIsMilesOnly(provider?: string | null): boolean {
  if (!provider) return false;
  return MILES_ONLY_PROVIDERS.has(String(provider).toLowerCase());
}

/** Map a country to the unit that country reports odometers in. */
export function unitForCountry(country: ShopCountry): DistanceUnit {
  return country === "CA" ? "kilometers" : "miles";
}

/**
 * Infer a shop's country from an address (state/province code or postal/ZIP
 * format). Returns null when the signal is absent or ambiguous.
 */
export function inferCountryFromAddress(
  addr: { state?: string | null; zip?: string | null } | null | undefined
): ShopCountry | null {
  const state = addr?.state ? String(addr.state).trim().toUpperCase() : "";
  const zip = addr?.zip ? String(addr.zip).trim().toUpperCase() : "";

  // State/province code is the strongest signal.
  if (state) {
    if (CA_PROVINCES.has(state)) return "CA";
    if (US_STATES.has(state)) return "US";
  }
  // Fall back to postal/ZIP format.
  if (zip) {
    if (CA_POSTAL.test(zip)) return "CA";
    if (US_ZIP.test(zip)) return "US";
  }
  return null;
}

/**
 * Resolve a shop's country: prefer an explicit backfilled `geo.country`, then
 * infer from a stored `geo` address. Returns null when unknown.
 */
export function resolveShopCountry(
  shopDoc: ShopDistanceDoc | null | undefined
): ShopCountry | null {
  const c = shopDoc?.geo?.country
    ? String(shopDoc.geo.country).trim().toUpperCase()
    : "";
  if (c === "CA" || c === "CAN" || c === "CANADA") return "CA";
  if (c === "US" || c === "USA" || c === "UNITED STATES") return "US";
  return inferCountryFromAddress(shopDoc?.geo ?? null);
}

/**
 * Whether a unit matches what the shop would resolve to AUTOMATICALLY (its
 * country, or the single-market safe default) — i.e. without a deliberate owner
 * override. Use this for AUTOMATED writes (sync jobs, backfill scripts) that
 * must not introduce the historical mislabel. It does NOT gate owner-driven
 * settings changes: an owner may deliberately override their unit (recorded via
 * `distanceUnitSource = "owner"`), which `resolveShopDistanceUnit` honors above
 * country. A unit is rejected only when it contradicts the shop's KNOWN country,
 * or — when the country is unknown — when it is "kilometers" on a single-market
 * miles provider. When the country is unknown and the provider is multi-market,
 * any unit matches.
 */
export function isDistanceUnitAllowed(
  shopDoc: ShopDistanceDoc | null | undefined,
  unit: DistanceUnit
): boolean {
  const country = resolveShopCountry(shopDoc);
  if (country) return unit === unitForCountry(country);
  if (unit === "kilometers" && providerIsMilesOnly(getShopProvider(shopDoc))) {
    return false;
  }
  return true;
}

/**
 * True when setting `unit` would diverge from the shop's automatic (country /
 * safe-default) unit — i.e. it is a genuine override the owner is opting into.
 * Used to decide whether to stamp `distanceUnitSource = "owner"`.
 */
export function isOverrideUnit(
  shopDoc: ShopDistanceDoc | null | undefined,
  unit: DistanceUnit
): boolean {
  return !isDistanceUnitAllowed(shopDoc, unit);
}

/**
 * Resolve a shop's effective distance unit per the policy above. This is the
 * function every consumer should use instead of reading
 * `preferences.distanceUnit` directly.
 */
export function resolveShopDistanceUnit(
  shopDoc: ShopDistanceDoc | null | undefined
): DistanceUnit {
  // 0. Explicit owner override wins.
  const override = getOwnerUnitOverride(shopDoc);
  if (override) return override;

  // 1. Known country is the smart default.
  const country = resolveShopCountry(shopDoc);
  if (country) return unitForCountry(country);

  // 2. Unknown country on a single-market miles provider -> safe default.
  const provider = getShopProvider(shopDoc);
  if (providerIsMilesOnly(provider)) return "miles";

  // 3. Unknown country, multi-market provider -> honor stored preference.
  const stored =
    shopDoc?.preferences?.distanceUnit ?? shopDoc?.settings?.distanceUnit;
  return stored === "kilometers" ? "kilometers" : "miles";
}
