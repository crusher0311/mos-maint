/**
 * Pure mapping helpers for the MyOilSticker → mos.tools migration
 * (task #1181). Extracted from scripts/migrate-myoilsticker-users.ts so the
 * mapping can be unit-tested without touching Mongo/PG.
 *
 * See docs/myoilsticker-migration-field-mapping.md for the field-by-field
 * rationale, including which legacy fields are deliberately dropped.
 */

import crypto from "node:crypto";

export const SOURCE_TAG = "myoilsticker"; // legacySource value on created docs

/**
 * Billing plan assigned to every freshly created legacy shop. The
 * `oil_sticker_legacy` plan's feature tier includes `oil_sticker` (plus
 * auto_booking / labor_rates) — see lib/plan-feature-tiers.ts — and
 * `status: "active"` satisfies featureResolver's isBillingActive(), so
 * migrated shops can actually use the sticker feature they came for.
 */
export const MIGRATED_BILLING = {
  plan: "oil_sticker_legacy",
  status: "active",
  cardOnFile: false,
} as const;

/**
 * Strict full-format bcrypt validation: `$2a$`/`$2b$`/`$2y$` version, a
 * two-digit cost (04–31), and exactly 53 chars of bcrypt-base64 payload
 * (22-char salt + 31-char hash). A merely bcrypt-*looking* prefix with a
 * truncated/malformed remainder must NOT pass — such accounts are imported
 * disabled (random hash + mustChangePassword) instead of carrying an
 * unusable hash into the login path.
 */
export function looksLikeBcrypt(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const m = /^\$2[aby]\$(\d{2})\$([./A-Za-z0-9]{53})$/.exec(v);
  if (!m) return false;
  const cost = Number(m[1]);
  return cost >= 4 && cost <= 31;
}

export const s = (v: unknown): string | null => {
  if (v == null) return null;
  const t = String(v).trim();
  return t.length ? t : null;
};

export const n = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const x = Number(String(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(x) ? x : null;
};

// Legacy stores abbreviations ("EST"); mos.tools uses IANA zones.
export const TZ_MAP: Record<string, string> = {
  EST: "America/New_York",
  EDT: "America/New_York",
  CST: "America/Chicago",
  CDT: "America/Chicago",
  MST: "America/Denver",
  MDT: "America/Denver",
  PST: "America/Los_Angeles",
  PDT: "America/Los_Angeles",
};

export type LegacyUser = Record<string, any>;

/** Build the mos.tools shop document for a legacy user (minus shopId). */
export function buildShopDoc(u: LegacyUser, now: Date): Record<string, any> {
  const name =
    s(u.targetShopTag) ??
    `${s(u.firstName) ?? ""} ${s(u.lastName) ?? ""}`.trim() ??
    s(u.email);
  const interval = {
    mileage: n(u.targetMile) ?? 3000,
    months: n(u.targetMonth) ?? 3,
  };
  const stickerConfig: Record<string, unknown> = {
    enabled: u.stickerStatus !== false,
    phone: s(u.targetPhone),
    tagline: s(u.targetShopTag),
    serviceLabel: s(u.text) ?? "Next Service Due",
    defaultSize: s(u.stickerSize) ?? "2x2",
    useKilometers: u.serviceUnit === "kms",
    appointmentUrl: s(u.targetSchedule),
    roundMileage: !!u.roundMileage,
    usePredictiveDate: !!u.predictiveDate,
    hovercodeQRId: s(u.hovercode),
    defaultOilType: "conventional",
    // Legacy has a single target interval; it lands on the default
    // (conventional) type. Other types keep platform defaults when the
    // shop later opens sticker settings.
    intervals: { conventional: interval },
    colors: {
      background: s(u.stickerBGColor) ?? "#000000",
      text: s(u.targetColor) ?? "#ffffff",
      phoneColor: s(u.stickerPhoneColor) ?? s(u.targetColor) ?? "#ffffff",
      taglineColor: s(u.stickerShopTagColor) ?? s(u.targetColor) ?? "#ffffff",
    },
  };
  const shop: Record<string, any> = {
    name: name || `MyOilSticker ${String(u._id)}`,
    phone: s(u.targetPhone),
    contactEmail: String(u.email).toLowerCase().trim(),
    status: "active",
    // Entitlements: plan grants oil_sticker; the explicit per-shop override
    // (`shops.enabledFeatures` — the only resolver-read override store)
    // belt-and-suspenders the sticker feature on even if the PG
    // platform_features tier rows change later.
    billing: { ...MIGRATED_BILLING },
    enabledFeatures: { oil_sticker: true },
    webhookToken: crypto.randomBytes(24).toString("hex"),
    stickerConfig,
    createdAt: u.createdAt instanceof Date ? u.createdAt : now,
    updatedAt: now,
    legacyOilStickerId: String(u._id),
    legacySource: SOURCE_TAG,
    legacyMigrationCreated: true, // rollback selector — NEVER set on linked users
    legacyMyOilSticker: buildLegacyMeta(u),
  };
  if (u.timeZone) shop.timezone = TZ_MAP[String(u.timeZone)] ?? String(u.timeZone);
  if (u.carfaxEnable != null || s(u.carfaxLocationId)) {
    shop.carfax = {
      enabled: !!u.carfaxEnable,
      ...(s(u.carfaxLocationId) ? { locationId: s(u.carfaxLocationId) } : {}),
    };
  }
  const lat = n(u.lat);
  const lon = n(u.lon);
  if (lat != null && lon != null) shop.location = { lat, lon };
  return shop;
}

/** Non-sensitive legacy bookkeeping kept for reference/billing follow-up. */
export function buildLegacyMeta(u: LegacyUser): Record<string, any> {
  return {
    legacyUserId: String(u._id),
    shopNum: s(u.shopNum),
    isSubscribed: !!u.isSubscribed,
    subDescription: s(u.subDescription),
    monthBilled: s(u.monthBilled),
    hasUsedTrial: !!u.hasUsedTrial,
    isEmailVerified: !!u.isEmailVerified,
    isFrozen: !!u.isFrozen,
    isAdmin: !!u.isAdmin,
    laborEnable: u.laborEnable ?? null,
    enableAutobook: u.enableAutobook ?? null,
    targetSiteType: s(u.targetSiteType), // which SMS the scraper targeted (1-5)
    targetURL: s(u.targetURL), // scraper site slug/url — no credentials
    legacyCreatedAt: u.createdAt ?? null,
    migratedAt: new Date(),
  };
}

export function buildCustomGroup(g: Record<string, any>) {
  return {
    name: s(g.name),
    makes: Array.isArray(g.makes) ? g.makes : [],
    laborRateCents: n(g.laborRate),
    legacyGroupId: String(g._id),
  };
}

/** Legacy fields that must never be copied anywhere. */
export const SENSITIVE_LEGACY_FIELDS = [
  "password", // migrated ONLY into users.passwordHash, never metadata
  "targetPwd",
  "targetUser",
  "cookieInfo",
  "cookieExpire",
  "tokenInfo",
  "tokenExpire",
  "apiKey",
] as const;
