import {
  getUserShopIds,
  type ExtensionAuthResult,
} from "@/lib/extension-auth";
import {
  autoflowIdentifierVariants,
  normalizeAutoflowIdentifier,
} from "@/lib/autoflow-identity";
import { listShopsByQuery } from "@/lib/data/repositories/shops";

export type LaborRateProvider =
  | "tekmetric"
  | "protractor"
  | "shopware"
  | "autoflow"
  | "shopmonkey";

const LABOR_RATE_PROVIDERS = new Set<LaborRateProvider>([
  "tekmetric",
  "protractor",
  "shopware",
  "autoflow",
  "shopmonkey",
]);

/**
 * Labor-rate lookup intentionally lives here instead of broadening
 * findShopBySmsId. The shared lookup has provider-specific recovery paths
 * (Shop-Ware/Shopmonkey discovery and AutoFlow attachment) that can persist a
 * mapping while resolving a page. Loading or saving labor rules must never
 * learn an identity as a side effect, so this route only reads already
 * persisted provider identity fields.
 */
export const __laborRateRouteDeps = {
  listShopsByQuery,
};

function normalizeProvider(value: unknown): string | null {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^shop[-_]ware$/, "shopware");
  return normalized || null;
}

function supportedProvider(value: unknown): value is LaborRateProvider {
  return typeof value === "string" && LABOR_RATE_PROVIDERS.has(value as LaborRateProvider);
}

function finiteShopId(value: unknown): number | null {
  const numeric = typeof value === "number" && Number.isFinite(value)
    ? value
    : typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : NaN;
  return Number.isSafeInteger(numeric) ? numeric : null;
}

export function scopedUserShopIds(user: any): number[] {
  try {
    return [...new Set(
      getUserShopIds(user)
        .map((id) => finiteShopId(id))
        .filter((id): id is number => id !== null),
    )];
  } catch {
    // A malformed membership record must fail closed rather than turning into
    // an unrestricted lookup.
    return [];
  }
}

function shopIdVariants(shopIds: number[]): Array<number | string> {
  return [...new Set(shopIds.flatMap((shopId) => [shopId, String(shopId)]))];
}

function pathValue(doc: any, path: string): unknown {
  return path.split(".").reduce((value, segment) => value?.[segment], doc);
}

function valuesAtPaths(doc: any, paths: string[]): unknown[] {
  return paths.flatMap((path) => {
    const value = pathValue(doc, path);
    return Array.isArray(value) ? value : [value];
  });
}

const PROVIDER_IDENTITY_PATHS: Record<LaborRateProvider, string[]> = {
  tekmetric: ["tekmetric.shopId", "tekmetricShopId"],
  protractor: ["protractor.connectionId", "protractorConnectionId"],
  shopware: ["shopware.tenantSubdomain", "shopware.tenantId"],
  autoflow: [
    "autoflow.domain",
    "autoflow.subdomain",
    "autoflow.shopId",
    "autoflow.shopNumbers",
    "autoflowDomain",
  ],
  shopmonkey: ["shopmonkey.locationId", "shopmonkey.companyId"],
};

function identityValueMatches(
  provider: LaborRateProvider,
  value: unknown,
  smsShopId: string,
): boolean {
  if (value === null || value === undefined || typeof value === "object") return false;
  if (provider === "tekmetric") {
    if (!/^\d+$/.test(smsShopId)) return false;
    if (typeof value === "number") {
      return Number.isSafeInteger(value) && value === Number(smsShopId);
    }
    return typeof value === "string" && value.trim() === smsShopId;
  }
  if (provider === "autoflow") {
    return normalizeAutoflowIdentifier(value) === normalizeAutoflowIdentifier(smsShopId);
  }
  return String(value).trim() === smsShopId;
}

function matchingProviders(doc: any, smsShopId: string): LaborRateProvider[] {
  return [...LABOR_RATE_PROVIDERS].filter((provider) =>
    valuesAtPaths(doc, PROVIDER_IDENTITY_PATHS[provider]).some((value) =>
      identityValueMatches(provider, value, smsShopId),
    ),
  );
}

function providerIdentityQuery(
  provider: LaborRateProvider,
  smsShopId: string,
): Record<string, unknown>[] {
  if (provider === "tekmetric") {
    if (!/^\d+$/.test(smsShopId)) return [];
    const values: Array<string | number> = [smsShopId, Number(smsShopId)];
    return PROVIDER_IDENTITY_PATHS[provider].map((path) => ({ [path]: { $in: values } }));
  }
  if (provider === "autoflow") {
    const values = autoflowIdentifierVariants(smsShopId);
    return PROVIDER_IDENTITY_PATHS[provider].map((path) => ({ [path]: { $in: values } }));
  }
  return PROVIDER_IDENTITY_PATHS[provider].map((path) => ({ [path]: smsShopId }));
}

function allProviderIdentityQuery(smsShopId: string): Record<string, unknown>[] {
  return [...LABOR_RATE_PROVIDERS].flatMap((provider) =>
    providerIdentityQuery(provider, smsShopId),
  );
}

export type LaborRateShopResolution =
  | {
      ok: true;
      mosShopId: number;
      shopDoc: any;
      provider: LaborRateProvider;
    }
  | {
      ok: false;
      status: 400 | 403 | 404;
      error: string;
      code?: "PROVIDER_FORBIDDEN" | "SHOP_FORBIDDEN";
    };

function effectiveProvider(
  auth: Pick<ExtensionAuthResult, "user" | "principal">,
  requestedProvider: string | null | undefined,
): { ok: true; provider: LaborRateProvider | null } | LaborRateShopResolution {
  const requested = normalizeProvider(requestedProvider);
  const principal = auth.principal ?? auth.user?.extensionPrincipal;
  const principalProvider =
    principal?.isLegacy !== true ? normalizeProvider(principal?.provider) : null;

  if (requested && !supportedProvider(requested)) {
    return {
      ok: false,
      status: 400,
      error: "Unsupported provider",
    };
  }
  if (principalProvider && !supportedProvider(principalProvider)) {
    return {
      ok: false,
      status: 403,
      error: "Unsupported provider scope",
      code: "PROVIDER_FORBIDDEN",
    };
  }
  if (principalProvider && requested && principalProvider !== requested) {
    return {
      ok: false,
      status: 403,
      error: "Session is scoped to a different provider",
      code: "PROVIDER_FORBIDDEN",
    };
  }

  return {
    ok: true,
    provider: (principalProvider || requested) as LaborRateProvider | null,
  };
}

/**
 * Resolve a labor-rate shop from a persisted provider identity while keeping
 * both the authenticated shop membership and provider scope authoritative.
 * A null/ambiguous/malformed identity is deliberately treated as unresolved;
 * this function never falls back to a MOS shopId or writes a new mapping.
 */
export async function resolveLaborRateShop(options: {
  auth: Pick<ExtensionAuthResult, "user" | "principal">;
  smsShopId: string;
  requestedProvider?: string | null;
}): Promise<LaborRateShopResolution> {
  const providerResult = effectiveProvider(options.auth, options.requestedProvider);
  if (!providerResult.ok) return providerResult;

  const isPlatformAdmin =
    options.auth.user?.role === "platform_admin" ||
    options.auth.user?.isPlatformAdmin === true;
  const userShopIds = scopedUserShopIds(options.auth.user);
  if (!isPlatformAdmin && userShopIds.length === 0) {
    return {
      ok: false,
      status: 403,
      error: "Unauthorized shop access",
      code: "SHOP_FORBIDDEN",
    };
  }

  const smsShopId = String(options.smsShopId ?? "").trim();
  if (!smsShopId || (providerResult.provider === "tekmetric" && !/^\d+$/.test(smsShopId))) {
    return {
      ok: false,
      status: 404,
      error: "No accessible shop configured for SMS shop ID",
    };
  }

  const identityQuery = providerResult.provider
    ? providerIdentityQuery(providerResult.provider, smsShopId)
    : allProviderIdentityQuery(smsShopId);
  const query: Record<string, unknown> = {
    $or: identityQuery,
  };
  if (!isPlatformAdmin) {
    query.shopId = { $in: shopIdVariants(userShopIds) };
  }

  const candidateDocs = await __laborRateRouteDeps.listShopsByQuery(query as any);
  const matchingDocs = candidateDocs.filter((doc: any) => {
    const providers = matchingProviders(doc, smsShopId);
    if (providerResult.provider) {
      const declaredProvider = normalizeProvider(doc?.integrationProvider);
      return (
        providers.includes(providerResult.provider) &&
        (!declaredProvider || declaredProvider === providerResult.provider)
      );
    }
    const declaredProvider = normalizeProvider(doc?.integrationProvider);
    return (
      providers.length === 1 &&
      (!declaredProvider || declaredProvider === providers[0])
    );
  });

  // More than one already-persisted candidate is an identity collision, not a
  // reason to guess. This also catches duplicate provider mappings within one
  // user's membership set.
  const uniqueMatchingDocs = [...new Map(
    matchingDocs.map((doc: any) => [String(doc?._id ?? `${doc?.shopId}:${doc?.integrationProvider}`), doc]),
  ).values()];
  if (uniqueMatchingDocs.length !== 1) {
    return {
      ok: false,
      status: 404,
      error: `No accessible shop configured for SMS shop ID ${smsShopId}`,
    };
  }

  const shopDoc = uniqueMatchingDocs[0];
  const mosShopId = finiteShopId(shopDoc?.shopId);
  const providers = matchingProviders(shopDoc, smsShopId);
  const provider = providerResult.provider || (providers.length === 1 ? providers[0] : null);
  const declaredProvider = normalizeProvider(shopDoc?.integrationProvider);
  if (
    mosShopId === null ||
    !provider ||
    !supportedProvider(provider) ||
    (declaredProvider && (!supportedProvider(declaredProvider) || declaredProvider !== provider))
  ) {
    return {
      ok: false,
      status: 404,
      error: `No accessible shop configured for SMS shop ID ${smsShopId}`,
    };
  }

  return { ok: true, mosShopId, shopDoc, provider };
}

export function defaultLaborRateShopId(
  auth: Pick<ExtensionAuthResult, "user" | "principal">,
  userShopIds: number[],
  isPlatformAdmin: boolean,
): LaborRateShopResolution {
  if (!isPlatformAdmin && userShopIds.length === 0) {
    return {
      ok: false,
      status: 403,
      error: "Unauthorized shop access",
      code: "SHOP_FORBIDDEN",
    };
  }
  const shopId = finiteShopId(auth.user?.shopId);
  if (shopId === null || (!isPlatformAdmin && !userShopIds.includes(shopId))) {
    return {
      ok: false,
      status: 403,
      error: "Unauthorized shop access",
      code: "SHOP_FORBIDDEN",
    };
  }
  return {
    ok: true,
    mosShopId: shopId,
    shopDoc: null,
    provider: "tekmetric",
  };
}