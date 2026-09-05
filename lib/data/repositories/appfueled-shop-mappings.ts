import { and, eq } from "drizzle-orm";
import { getDb as getPgDb } from "@/lib/db/drizzle";
import { appfueledShopMappings } from "@/lib/db/schema/wave2";
import { findShopBySmsIdDetailed } from "@/lib/extension-shop-lookup";

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
  const resolved = await findShopBySmsIdDetailed(input.externalShopId, {
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