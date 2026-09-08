import { and, eq } from "drizzle-orm";
import { getDb as getPgDb } from "@/lib/db/drizzle";
import { appfueledShopMappings } from "@/lib/db/schema/wave2";
import { findShopBySmsIdDetailed } from "@/lib/extension-shop-lookup";
import { getShopById } from "@/lib/shops";

export const APPFUELED_NAMESPACE = "live_api" as const;
export const APPFUELED_PROVIDERS = [
  "tekmetric",
  "shopware",
  "protractor",
  "autoflow",
  "shopmonkey",
] as const;
export type AppFueledProvider = (typeof APPFUELED_PROVIDERS)[number];

export type AppFueledMappingInput = {
  externalShopId: string;
  mosShopId: number;
  provider: AppFueledProvider;
};

export class AppFueledMappingValidationError extends Error {}

export const __deps = {
  findShopBySmsIdDetailed,
  getShopById,
  resolveActiveAppFueledMapping,
};

function normalizeProvider(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^shop[-_]ware$/, "shopware");
}

export async function validateAuthoritativeMapping(input: AppFueledMappingInput) {
  const externalShopId = input.externalShopId.trim();

  // AppFueled's live_api shop identifier may be the MOS shop ID itself.
  // Accept that form only when the decimal string is an exact match, then
  // validate the shop and provider directly. This avoids sending a trusted MOS
  // identity through the extension's compatibility resolver while preserving
  // the provider-issued-ID path for every other mapping.
  if (externalShopId === String(input.mosShopId)) {
    const shop = await __deps.getShopById(input.mosShopId);
    if (!shop) {
      throw new AppFueledMappingValidationError(
        `MOS shop ${input.mosShopId} was not found`,
      );
    }
    const configuredProvider = normalizeProvider(shop.integrationProvider);
    if (!configuredProvider) {
      throw new AppFueledMappingValidationError(
        `MOS shop ${input.mosShopId} does not have a canonical provider configured`,
      );
    }
    if (configuredProvider !== input.provider) {
      throw new AppFueledMappingValidationError(
        `MOS shop ${input.mosShopId} is canonically configured for ${configuredProvider}, not ${input.provider}`,
      );
    }
    return;
  }

  const resolved = await __deps.findShopBySmsIdDetailed(externalShopId, {
    isPlatformAdmin: true,
    providerHint: input.provider,
    providerHintIsAuthoritative: true,
  });
  if (resolved.status !== "resolved") {
    throw new AppFueledMappingValidationError(
      resolved.status === "conflict"
        ? "External shop identifier is ambiguous for the canonical provider"
        : "External shop identifier is not configured on the canonical provider",
    );
  }
  if (Number(resolved.mosShopId) !== input.mosShopId || resolved.provider !== input.provider) {
    throw new AppFueledMappingValidationError(
      `Canonical ${input.provider} identity belongs to MOS shop ${resolved.mosShopId}, not ${input.mosShopId}`,
    );
  }
  const configuredProvider = normalizeProvider(resolved.shopDoc?.integrationProvider);
  if (configuredProvider && configuredProvider !== input.provider) {
    throw new AppFueledMappingValidationError(
      `MOS shop ${input.mosShopId} is canonically configured for ${configuredProvider}, not ${input.provider}`,
    );
  }
}

export async function resolveActiveAppFueledMapping(externalShopId: string) {
  const id = externalShopId.trim();
  const rows = await getPgDb()
    .select()
    .from(appfueledShopMappings)
    .where(and(
      eq(appfueledShopMappings.namespace, APPFUELED_NAMESPACE),
      eq(appfueledShopMappings.externalShopId, id),
      eq(appfueledShopMappings.isActive, true),
    ))
    .limit(2);
  if (rows.length !== 1) return null;
  const row = rows[0];
  await validateAuthoritativeMapping({
    externalShopId: row.externalShopId,
    mosShopId: row.mosShopId,
    provider: row.provider as AppFueledProvider,
  });
  return row;
}

/**
 * live_api uses MOS shop IDs, not a per-partner shop allowlist. Numeric IDs
 * always identify MOS shops directly; only legacy external IDs need mapping.
 * Authentication and partner permissions are enforced by the calling route.
 */
export async function resolveAppFueledShop(shopIdentifier: string) {
  const id = shopIdentifier.trim();
  if (/^[1-9]\d*$/.test(id)) {
    const mosShopId = Number(id);
    if (!Number.isSafeInteger(mosShopId)) {
      throw new AppFueledMappingValidationError("MOS shop ID must be a positive safe integer");
    }
    const shop = await __deps.getShopById(mosShopId);
    if (!shop) return null;
    const provider = normalizeProvider(shop.integrationProvider);
    if (!APPFUELED_PROVIDERS.includes(provider as AppFueledProvider)) {
      throw new AppFueledMappingValidationError(
        `MOS shop ${mosShopId} does not have a supported canonical provider configured`,
      );
    }
    return { mosShopId, provider: provider as AppFueledProvider };
  }
  // Do not coerce malformed numeric IDs or reinterpret them as provider IDs.
  if (!id || Number.isFinite(Number(id))) {
    throw new AppFueledMappingValidationError("MOS shop ID must use its exact positive decimal form");
  }
  return __deps.resolveActiveAppFueledMapping(id);
}

export async function listAppFueledMappings() {
  return getPgDb().select().from(appfueledShopMappings);
}

export async function createAppFueledMapping(
  input: AppFueledMappingInput,
  actor: string,
) {
  await validateAuthoritativeMapping(input);
  const [row] = await getPgDb().insert(appfueledShopMappings).values({
    namespace: APPFUELED_NAMESPACE,
    externalShopId: input.externalShopId.trim(),
    mosShopId: input.mosShopId,
    provider: input.provider,
    isActive: true,
    createdBy: actor,
    updatedBy: actor,
  }).returning();
  return row;
}

export async function updateAppFueledMapping(
  externalShopId: string,
  input: AppFueledMappingInput & { isActive?: boolean },
  actor: string,
) {
  await validateAuthoritativeMapping(input);
  const [row] = await getPgDb().update(appfueledShopMappings).set({
    externalShopId: input.externalShopId.trim(),
    mosShopId: input.mosShopId,
    provider: input.provider,
    ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
    updatedBy: actor,
    updatedAt: new Date(),
    ...(input.isActive === false ? { disabledAt: new Date(), disabledBy: actor } : {
      disabledAt: null,
      disabledBy: null,
    }),
  }).where(and(
    eq(appfueledShopMappings.namespace, APPFUELED_NAMESPACE),
    eq(appfueledShopMappings.externalShopId, externalShopId.trim()),
  )).returning();
  return row ?? null;
}

export async function disableAppFueledMapping(externalShopId: string, actor: string) {
  const [row] = await getPgDb().update(appfueledShopMappings).set({
    isActive: false,
    updatedBy: actor,
    updatedAt: new Date(),
    disabledBy: actor,
    disabledAt: new Date(),
  }).where(and(
    eq(appfueledShopMappings.namespace, APPFUELED_NAMESPACE),
    eq(appfueledShopMappings.externalShopId, externalShopId.trim()),
  )).returning();
  return row ?? null;
}