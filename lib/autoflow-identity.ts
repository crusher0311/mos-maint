export type AutoflowCanonicalClaimKind =
  | "autoflow.domain"
  | "autoflow.subdomain"
  | "autoflow.shopId"
  | "autoflowDomain";

export interface AutoflowIdentifierClaim {
  shopId: string | number;
  shopName: string;
  claimType: "canonical" | "alias";
  field: AutoflowCanonicalClaimKind | "autoflow.shopNumbers";
  value: string;
}

export interface AutoflowIdentifierConflict {
  identifier: string;
  reason: "multiple_canonical" | "multiple_aliases" | "canonical_alias_collision";
  canonicalClaims: AutoflowIdentifierClaim[];
  aliasClaims: AutoflowIdentifierClaim[];
}

export class AutoflowAtomicClaimConflictError extends Error {
  ownerShopId: string | number | null;

  constructor(identifier: string, ownerShopId: string | number | null) {
    super(
      `AutoFlow identifier ${identifier} is already reserved by shop ${
        ownerShopId ?? "unknown"
      }`,
    );
    this.name = "AutoflowAtomicClaimConflictError";
    this.ownerShopId = ownerShopId;
  }
}

const AUTOFLOW_CLAIMS_COLLECTION = "autoflow_identifier_claims";

export function normalizeAutoflowIdentifier(value: unknown): string {
  let normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return "";

  try {
    if (/^https?:\/\//.test(normalized)) {
      normalized = new URL(normalized).hostname;
    }
  } catch {
    return "";
  }

  normalized = normalized.split("/")[0].replace(/\.$/, "");
  if (normalized.endsWith(".autotext.me")) {
    normalized = normalized.slice(0, -".autotext.me".length);
  }
  return normalized;
}

export function isAutoflowV4ShopNumber(value: unknown): boolean {
  return /^\d{1,64}$/.test(String(value ?? "").trim());
}

export function autoflowIdentifierVariants(value: unknown): Array<string | number> {
  const raw = String(value ?? "").trim();
  const normalized = normalizeAutoflowIdentifier(raw);
  if (!normalized) return [];

  const variants: Array<string | number> = [
      raw,
      raw.toLowerCase(),
      normalized,
      `${normalized}.autotext.me`,
  ];
  if (/^\d+$/.test(normalized)) variants.push(Number(normalized));
  return Array.from(new Set(variants));
}

export function buildAutoflowClaimQuery(identifier: unknown) {
  const variants = autoflowIdentifierVariants(identifier);
  return {
    $or: [
      { "autoflow.domain": { $in: variants } },
      { "autoflow.subdomain": { $in: variants } },
      { "autoflow.shopId": { $in: variants } },
      { autoflowDomain: { $in: variants } },
      { "autoflow.shopNumbers": { $in: variants } },
    ],
  };
}

function claim(
  shop: any,
  claimType: "canonical" | "alias",
  field: AutoflowIdentifierClaim["field"],
  value: unknown,
): AutoflowIdentifierClaim | null {
  if (value == null || String(value).trim() === "") return null;
  return {
    shopId: shop.shopId,
    shopName: shop.name || `Shop ${shop.shopId}`,
    claimType,
    field,
    value: String(value).trim(),
  };
}

export function getAutoflowClaimsForShop(shop: any): AutoflowIdentifierClaim[] {
  const claims: AutoflowIdentifierClaim[] = [];
  const canonicalValues: Array<[AutoflowCanonicalClaimKind, unknown]> = [
    ["autoflow.domain", shop?.autoflow?.domain],
    ["autoflow.subdomain", shop?.autoflow?.subdomain],
    ["autoflow.shopId", shop?.autoflow?.shopId],
    ["autoflowDomain", shop?.autoflowDomain],
  ];
  for (const [field, value] of canonicalValues) {
    const item = claim(shop, "canonical", field, value);
    if (item) claims.push(item);
  }
  for (const value of shop?.autoflow?.shopNumbers || []) {
    const item = claim(shop, "alias", "autoflow.shopNumbers", value);
    if (item) claims.push(item);
  }
  return claims;
}

function uniqueShopClaims(claims: AutoflowIdentifierClaim[]) {
  const seen = new Set<string>();
  return claims.filter((item) => {
    const key = String(item.shopId);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function classifyAutoflowIdentifierClaims(
  shops: any[],
  identifier: unknown,
): {
  identifier: string;
  canonicalClaims: AutoflowIdentifierClaim[];
  aliasClaims: AutoflowIdentifierClaim[];
} {
  const normalized = normalizeAutoflowIdentifier(identifier);
  const matching = shops.flatMap(getAutoflowClaimsForShop).filter(
    (item) => normalizeAutoflowIdentifier(item.value) === normalized,
  );
  return {
    identifier: normalized,
    canonicalClaims: uniqueShopClaims(
      matching.filter((item) => item.claimType === "canonical"),
    ),
    aliasClaims: uniqueShopClaims(
      matching.filter((item) => item.claimType === "alias"),
    ),
  };
}

export function findAutoflowIdentifierConflicts(
  shops: any[],
): AutoflowIdentifierConflict[] {
  const identifiers = new Set<string>();
  for (const shop of shops) {
    for (const item of getAutoflowClaimsForShop(shop)) {
      const normalized = normalizeAutoflowIdentifier(item.value);
      if (normalized) identifiers.add(normalized);
    }
  }

  const conflicts: AutoflowIdentifierConflict[] = [];
  for (const identifier of identifiers) {
    const { canonicalClaims, aliasClaims } = classifyAutoflowIdentifierClaims(
      shops,
      identifier,
    );
    const canonicalShopIds = new Set(canonicalClaims.map((item) => String(item.shopId)));
    const aliasesOnOtherShops = aliasClaims.filter(
      (item) => !canonicalShopIds.has(String(item.shopId)),
    );

    let reason: AutoflowIdentifierConflict["reason"] | null = null;
    if (canonicalClaims.length > 1) reason = "multiple_canonical";
    else if (canonicalClaims.length === 0 && aliasClaims.length > 1) {
      reason = "multiple_aliases";
    } else if (canonicalClaims.length > 0 && aliasesOnOtherShops.length > 0) {
      reason = "canonical_alias_collision";
    }

    if (reason) {
      conflicts.push({ identifier, reason, canonicalClaims, aliasClaims });
    }
  }
  return conflicts.sort((a, b) => a.identifier.localeCompare(b.identifier));
}

export function claimsBlockingAutoflowAttachment(
  shops: any[],
  identifier: unknown,
  targetShopId: string | number,
): AutoflowIdentifierClaim[] {
  const claims = classifyAutoflowIdentifierClaims(shops, identifier);
  return [...claims.canonicalClaims, ...claims.aliasClaims].filter(
    (item) => String(item.shopId) !== String(targetShopId),
  );
}

export async function acquireAutoflowAliasClaim(
  db: any,
  identifier: unknown,
  shopId: string | number,
  metadata: { source: "auto_learning" | "platform_admin"; actor?: string | null },
  session?: any,
): Promise<{ normalizedIdentifier: string; created: boolean }> {
  const normalizedIdentifier = normalizeAutoflowIdentifier(identifier);
  if (!normalizedIdentifier) {
    throw new Error("Invalid AutoFlow identifier");
  }

  const claimDoc = {
    _id: normalizedIdentifier,
    normalizedIdentifier,
    ownerShopId: shopId,
    claimType: "alias",
    source: metadata.source,
    actor: metadata.actor || null,
    claimedAt: new Date(),
  };

  try {
    await db.collection(AUTOFLOW_CLAIMS_COLLECTION).insertOne(
      claimDoc,
      session ? { session } : undefined,
    );
    return { normalizedIdentifier, created: true };
  } catch (error: any) {
    if (error?.code !== 11000) throw error;
    const existing = await db
      .collection(AUTOFLOW_CLAIMS_COLLECTION)
      .findOne(
        { _id: normalizedIdentifier },
        session ? { session } : undefined,
      );
    if (existing && String(existing.ownerShopId) === String(shopId)) {
      return { normalizedIdentifier, created: false };
    }
    throw new AutoflowAtomicClaimConflictError(
      normalizedIdentifier,
      existing?.ownerShopId ?? null,
    );
  }
}

export async function releaseAutoflowAliasClaim(
  db: any,
  normalizedIdentifier: string,
  shopId: string | number,
  session?: any,
): Promise<void> {
  await db.collection(AUTOFLOW_CLAIMS_COLLECTION).deleteOne(
    {
      _id: normalizedIdentifier,
      ownerShopId: shopId,
    },
    session ? { session } : undefined,
  );
}

export async function withAutoflowClaimTransaction<T>(
  getClient: () => Promise<any>,
  work: (session?: any) => Promise<T>,
): Promise<T> {
  const client = await getClient();
  if (!client?.startSession) return work(undefined);

  const session = client.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}