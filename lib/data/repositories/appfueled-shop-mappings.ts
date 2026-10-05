import { and, eq } from "drizzle-orm";
import { getDb as getPgDb } from "@/lib/db/drizzle";
import { appfueledShopMappings } from "@/lib/db/schema/wave2";
import { findShopBySmsIdDetailed } from "@/lib/extension-shop-lookup";
import { findShopByShopId } from "@/lib/data/repositories/shops";

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

export async function validateAuthoritativeMapping(input: AppFueledMappingInput) {
  // AppFueled's live_api smsShopId is a MOS shop ID, not an upstream
  // provider ID. An active operator-managed row is still required.
  if (!Number.isSafeInteger(input.mosShopId) || input.mosShopId <= 0 ||
      input.externalShopId.trim() !== String(input.mosShopId)) {
    throw new AppFueledMappingValidationError("live_api shop identifier must match the authorized MOS shop ID");
  }
  if (!APPFUELED_PROVIDERS.includes(input.provider)) {
    throw new AppFueledMappingValidationError("Unsupported canonical provider");
  }
  const target = await findShopByShopId(input.mosShopId);
  if (!target) {
    throw new AppFueledMappingValidationError("MOS shop does not exist");
  }
  const provider = String(target.integrationProvider || "").trim().toLowerCase().replace(/^shop[-_]ware$/, "shopware");
  if (provider !== input.provider) {
    throw new AppFueledMappingValidationError("MOS shop canonical provider does not match the authorized mapping");
  }
  // Resolve the shop's configured upstream identity, not the request's MOS ID.
  // The authoritative lookup rejects ambiguity and never learns aliases.
  const field = (config: unknown, key: string): unknown =>
    config && typeof config === "object"
      ? (config as Record<string, unknown>)[key]
      : undefined;
  const identifiers: Record<AppFueledProvider, unknown> = {
    tekmetric: field(target.tekmetric, "shopId") ?? target.tekmetricShopId,
    protractor: field(target.protractor, "connectionId") ?? target.protractorConnectionId,
    shopware: field(target.shopware, "tenantId") ?? field(target.shopware, "tenantSubdomain"),
    shopmonkey: field(target.shopmonkey, "locationId") ?? field(target.shopmonkey, "companyId"),
    autoflow: field(target.autoflow, "domain") ?? field(target.autoflow, "subdomain") ?? field(target.autoflow, "shopId") ?? target.autoflowDomain,
  };
  const canonicalId = identifiers[input.provider];
  if ((typeof canonicalId !== "string" && typeof canonicalId !== "number") ||
      !String(canonicalId).trim()) {
    throw new AppFueledMappingValidationError("MOS shop canonical provider identity is not configured");
  }
  const resolved = await findShopBySmsIdDetailed(String(canonicalId), {
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
  const configuredProvider = String(resolved.shopDoc?.integrationProvider || "")
    .trim()
    .toLowerCase()
    .replace(/^shop[-_]ware$/, "shopware");
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