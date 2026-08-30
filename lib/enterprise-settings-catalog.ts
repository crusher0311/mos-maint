import {
  canManageEnterpriseLaborRates,
  normalizeLaborRateRuleSet,
} from "@/lib/labor-rate-rules";

export const ENTERPRISE_SETTING_CATEGORIES = [
  "branding",
  "maintenance",
  "intervals",
  "cannedJobs",
  "laborRates",
  "stickers",
] as const;

export type EnterpriseSettingCategory =
  (typeof ENTERPRISE_SETTING_CATEGORIES)[number];

export const ENTERPRISE_SETTING_CATEGORY_DETAILS: Record<
  EnterpriseSettingCategory,
  { label: string; description: string }
> = {
  branding: {
    label: "Branding",
    description: "Logo and shared visual identity",
  },
  maintenance: {
    label: "Maintenance thresholds",
    description: "Due-soon mileage and day thresholds",
  },
  intervals: {
    label: "Service intervals",
    description: "Custom intervals, application mode, and chemical providers",
  },
  cannedJobs: {
    label: "Canned-job mappings",
    description: "Mappings, manual jobs, and hidden jobs",
  },
  laborRates: {
    label: "Labor-rate rules",
    description: "Prioritized conditional labor-rate rules",
  },
  stickers: {
    label: "Oil-sticker configuration",
    description: "Sticker design and defaults, excluding location-specific fields",
  },
};

export interface EnterpriseSettingsValues {
  branding: { logo: unknown };
  maintenance: { dueSoonMiles: unknown; dueSoonDays: unknown };
  intervals: {
    values: Record<string, unknown>;
    applyMode: unknown;
    chemicalProviders: unknown[];
  };
  cannedJobs: {
    mappings: Record<string, unknown>;
    manualJobs: unknown[];
    hiddenIds: unknown[];
  };
  laborRates: unknown[];
  stickers: Partial<Record<(typeof COPYABLE_STICKER_FIELDS)[number], unknown>>;
}

export type EnterpriseSettingsSnapshot = {
  [Category in EnterpriseSettingCategory]?: EnterpriseSettingsValues[Category];
};

export const PROTECTED_STICKER_FIELDS = [
  "phone",
  "appointmentUrl",
  "hovercodeQRId",
  "hovercodeShortUrl",
  "hovercodeProvisionedAt",
  "cachedQrCodeDataUri",
  "qrCachedAt",
  "qrLogoPatchedAt",
  "updatedAt",
  "updatedBy",
] as const;

const COPYABLE_STICKER_FIELDS = [
  "enabled",
  "logo",
  "logoObjectPath",
  "tagline",
  "taglineLine2",
  "serviceLabel",
  "fontStyles",
  "colors",
  "useKilometers",
  "roundMileage",
  "designerLayout",
  "defaultSize",
  "showQRCode",
  "usePredictiveDate",
  "intervals",
  "defaultOilType",
] as const;

function valueOrClear<T>(value: T | undefined, clearValue: T): T;
function valueOrClear<T>(value: T | undefined): T | null;
function valueOrClear<T>(value: T | undefined, clearValue: T | null = null) {
  return value === undefined ? clearValue : structuredClone(value);
}

/**
 * The sole catalog of cross-location settings. Readers and writers deliberately
 * use the same descriptors so adding a category cannot create a read/copy
 * mismatch. Every writer emits every owned path; empty sources therefore clear
 * stale destination data.
 */
type EnterpriseSettingsCatalog = {
  [Category in EnterpriseSettingCategory]: {
    snapshot: (shop: any) => EnterpriseSettingsValues[Category];
    replacements: (
      value: EnterpriseSettingsValues[Category] | undefined,
    ) => Record<string, unknown>;
  };
};

export const enterpriseSettingsCatalog: EnterpriseSettingsCatalog = {
  branding: {
    snapshot: (shop) => ({
      logo: valueOrClear(shop.branding?.logo ?? shop.logo),
    }),
    replacements: (value) => ({ "branding.logo": value?.logo ?? null }),
  },
  maintenance: {
    snapshot: (shop) => ({
      dueSoonMiles: valueOrClear(shop.maintenance?.dueSoonMiles),
      dueSoonDays: valueOrClear(shop.maintenance?.dueSoonDays),
    }),
    replacements: (value) => ({
      "maintenance.dueSoonMiles": value?.dueSoonMiles ?? null,
      "maintenance.dueSoonDays": value?.dueSoonDays ?? null,
    }),
  },
  intervals: {
    snapshot: (shop) => ({
      values: valueOrClear(shop.maintenance?.intervals, {}),
      applyMode: valueOrClear(shop.maintenance?.intervalApplyMode),
      chemicalProviders: valueOrClear(
        shop.maintenance?.chemicalProviders,
        [],
      ),
    }),
    replacements: (value) => ({
      "maintenance.intervals": value?.values ?? {},
      "maintenance.intervalApplyMode": value?.applyMode ?? null,
      "maintenance.chemicalProviders": value?.chemicalProviders ?? [],
    }),
  },
  cannedJobs: {
    snapshot: (shop) => ({
      mappings: valueOrClear(
        shop.cannedJobMappings ?? shop.protractor?.cannedJobMappings,
        {},
      ),
      manualJobs: valueOrClear(
        shop.manualCannedJobs ?? shop.protractor?.manualCannedJobs,
        [],
      ),
      hiddenIds: valueOrClear(
        shop.hiddenCannedJobIds ?? shop.protractor?.hiddenJobIds,
        [],
      ),
    }),
    replacements: (value) => {
      const mappings = value?.mappings ?? {};
      const manualJobs = value?.manualJobs ?? [];
      const hiddenIds = value?.hiddenIds ?? [];
      return {
        cannedJobMappings: mappings,
        manualCannedJobs: manualJobs,
        hiddenCannedJobIds: hiddenIds,
        "protractor.cannedJobMappings": mappings,
        "protractor.manualCannedJobs": manualJobs,
        "protractor.hiddenJobIds": hiddenIds,
      };
    },
  },
  laborRates: {
    snapshot: (shop) => normalizeLaborRateRuleSet(shop.laborRateRules ?? []),
    replacements: (value) => ({
      laborRateRules: normalizeLaborRateRuleSet(value ?? []),
    }),
  },
  stickers: {
    snapshot: (shop) => {
      const source = shop.stickerConfig ?? {};
      return Object.fromEntries(
        COPYABLE_STICKER_FIELDS.map((field) => [
          field,
          valueOrClear(source[field]),
        ]),
      );
    },
    replacements: (value) =>
      Object.fromEntries(
        COPYABLE_STICKER_FIELDS.map((field) => [
          `stickerConfig.${field}`,
          value?.[field] ?? null,
        ]),
      ),
  },
};

export function parseEnterpriseSettingCategories(
  input: unknown,
): EnterpriseSettingCategory[] {
  if (input === undefined || input === null || input === "all") {
    return [...ENTERPRISE_SETTING_CATEGORIES];
  }
  const values = Array.isArray(input) ? input : [input];
  if (values.length === 0) throw new Error("At least one setting type is required");
  if (values.includes("all")) {
    if (values.length !== 1) {
      throw new Error('"all" cannot be combined with other setting types');
    }
    return [...ENTERPRISE_SETTING_CATEGORIES];
  }
  const allowed = new Set<string>(ENTERPRISE_SETTING_CATEGORIES);
  const unique = [...new Set(values)];
  if (unique.some((value) => typeof value !== "string" || !allowed.has(value))) {
    throw new Error("Invalid setting type");
  }
  return unique as EnterpriseSettingCategory[];
}

export function snapshotEnterpriseSettings(
  shop: any,
  categories: EnterpriseSettingCategory[],
): EnterpriseSettingsSnapshot {
  return Object.fromEntries(
    categories.map((category) => [
      category,
      enterpriseSettingsCatalog[category].snapshot(shop),
    ]),
  ) as EnterpriseSettingsSnapshot;
}

export function buildEnterpriseSettingsReplacement(
  snapshot: EnterpriseSettingsSnapshot,
  categories: EnterpriseSettingCategory[],
): Record<string, unknown> {
  return Object.assign(
    {},
    ...categories.map((category) =>
      // The key controls both sides; TS cannot preserve that correlation while
      // indexing a mapped type with a union.
      enterpriseSettingsCatalog[category].replacements(
        snapshot[category] as never,
      ),
    ),
  );
}

export function canManageEnterpriseSettings(session: {
  role?: string | null;
  isPlatformAdmin?: boolean;
  isImpersonation?: boolean;
}) {
  return (
    ["owner", "admin", "enterprise_admin", "platform_admin"].includes(
      session.role || "",
    ) ||
    session.isPlatformAdmin === true ||
    session.isImpersonation === true
  );
}

export function canManageEnterpriseSettingSelection(
  session: {
    role?: string | null;
    isPlatformAdmin?: boolean;
    isImpersonation?: boolean;
  },
  categories: EnterpriseSettingCategory[],
) {
  if (!canManageEnterpriseSettings(session)) return false;
  return (
    !categories.includes("laborRates") ||
    canManageEnterpriseLaborRates(session)
  );
}