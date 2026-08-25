// Repository for AutoFlow v4 shop-number management (task #884).
//
// AutoFlow's v4 UI (app.autoflow.com/shop/<number>/...) identifies shops by
// a number that often isn't stored on any shop doc. Extension lookups fail
// CLOSED on such misses and record them in `autoflow_unresolved_numbers`;
// a platform admin reviews them and attaches each number to the right
// shop's `autoflow.shopNumbers`.
import { getDb, getMongoClient } from "@/lib/data/db";
import {
  acquireAutoflowAliasClaim,
  AutoflowAtomicClaimConflictError,
  buildAutoflowClaimQuery,
  claimsBlockingAutoflowAttachment,
  findAutoflowIdentifierConflicts as collectAutoflowIdentifierConflicts,
  getAutoflowClaimsForShop,
  isAutoflowV4ShopNumber,
  normalizeAutoflowIdentifier,
  releaseAutoflowAliasClaim,
  withAutoflowClaimTransaction,
  type AutoflowIdentifierClaim,
  type AutoflowIdentifierConflict,
} from "@/lib/autoflow-identity";

const UNRESOLVED_COLLECTION = "autoflow_unresolved_numbers";

export const __deps = {
  getDb,
  getMongoClient,
};

export interface UnresolvedAutoflowNumberDoc {
  number: string;
  firstSeenAt?: Date | null;
  lastSeenAt?: Date | null;
  seenCount?: number;
  candidateShopIds?: (string | number)[];
  candidateCount?: number;
  resolvedShopId?: string | number | null;
  resolvedAt?: Date | null;
  resolvedBy?: string | null;
  reason?: string | null;
}

export interface AutoflowShopSummary {
  shopId: string | number;
  name: string;
  autoflowDomain: string | null;
  canonicalIdentifiers: string[];
  shopNumbers: string[];
}

export async function listUnresolvedAutoflowNumbers(
  limit = 200,
): Promise<UnresolvedAutoflowNumberDoc[]> {
  const db = await __deps.getDb();
  return db
    .collection(UNRESOLVED_COLLECTION)
    .find({ resolvedShopId: null })
    .sort({ lastSeenAt: -1 })
    .limit(limit)
    .toArray() as unknown as Promise<UnresolvedAutoflowNumberDoc[]>;
}

// AutoFlow-connected shops (attach targets) + shops already carrying v4
// numbers (current mappings).
export async function listAutoflowShops(): Promise<AutoflowShopSummary[]> {
  const db = await __deps.getDb();
  const shops = await db
    .collection("shops")
    .find(
      {
        $or: [
          { "autoflow.domain": { $exists: true } },
          { "autoflow.subdomain": { $exists: true } },
          { "autoflow.shopId": { $exists: true } },
          { "autoflow.configured": true },
          { "autoflow.shopNumbers.0": { $exists: true } },
          { autoflowDomain: { $exists: true } },
        ],
      },
      {
        projection: {
          shopId: 1,
          name: 1,
          "autoflow.domain": 1,
          "autoflow.subdomain": 1,
          "autoflow.shopNumbers": 1,
          autoflowDomain: 1,
        },
      },
    )
    .sort({ name: 1 })
    .toArray();
  return shops.map((s: any) => ({
    shopId: s.shopId,
    name: s.name || `Shop ${s.shopId}`,
    autoflowDomain:
      s.autoflow?.domain || s.autoflowDomain || s.autoflow?.subdomain || null,
    canonicalIdentifiers: getAutoflowClaimsForShop(s)
      .filter((claim) => claim.claimType === "canonical")
      .map((claim) => claim.value),
    shopNumbers: s.autoflow?.shopNumbers || [],
  }));
}

export async function listAutoflowIdentifierConflicts(): Promise<
  AutoflowIdentifierConflict[]
> {
  const db = await __deps.getDb();
  const shops = await db.collection("shops").find(
    {
      $or: [
        { "autoflow.domain": { $exists: true } },
        { "autoflow.subdomain": { $exists: true } },
        { "autoflow.shopId": { $exists: true } },
        { "autoflow.shopNumbers.0": { $exists: true } },
        { autoflowDomain: { $exists: true } },
      ],
    },
    {
      projection: {
        shopId: 1,
        name: 1,
        autoflow: 1,
        autoflowDomain: 1,
      },
    },
  ).toArray();
  return collectAutoflowIdentifierConflicts(shops);
}

export async function findShopByIdBasic(shopId: string | number) {
  const db = await __deps.getDb();
  return db.collection("shops").findOne(
    { shopId },
    { projection: { shopId: 1, name: 1, autoflow: 1, autoflowDomain: 1 } },
  );
}

// Guard helper: an AutoFlow identifier may only be attached when no canonical
// identity or learned alias on ANOTHER shop already owns it.
export async function findAutoflowIdentifierClaimConflicts(
  identifier: string,
  excludeShopId: string | number,
): Promise<AutoflowIdentifierClaim[]> {
  const db = await __deps.getDb();
  const shops = await db.collection("shops")
    .find(buildAutoflowClaimQuery(identifier), {
      collation: { locale: "en", strength: 2 },
    })
    .toArray();
  return claimsBlockingAutoflowAttachment(shops, identifier, excludeShopId);
}

export class AutoflowIdentifierConflictError extends Error {
  claims: AutoflowIdentifierClaim[];

  constructor(identifier: string, claims: AutoflowIdentifierClaim[]) {
    super(`AutoFlow identifier ${identifier} is already claimed by another shop`);
    this.name = "AutoflowIdentifierConflictError";
    this.claims = claims;
  }
}

export class AutoflowAliasNotOwnedError extends Error {
  constructor(identifier: string, shopId: string | number) {
    super(`AutoFlow identifier ${identifier} is not attached to shop ${shopId}`);
    this.name = "AutoflowAliasNotOwnedError";
  }
}

export async function attachAutoflowNumber(
  shopId: string | number,
  number: string,
  resolvedBy: string | null,
): Promise<void> {
  if (!isAutoflowV4ShopNumber(number)) {
    throw new Error("Invalid AutoFlow v4 shop number");
  }
  const db = await __deps.getDb();
  const conflicts = await findAutoflowIdentifierClaimConflicts(number, shopId);
  if (conflicts.length > 0) {
    throw new AutoflowIdentifierConflictError(number, conflicts);
  }
  const auditEntry = {
    action: "attached",
    shopId,
    actor: resolvedBy,
    at: new Date(),
  };
  await withAutoflowClaimTransaction(
    () => __deps.getMongoClient(),
    async (session) => {
      let reservation:
        | { normalizedIdentifier: string; created: boolean }
        | undefined;
      let aliasAdded = false;
      try {
        try {
          reservation = await acquireAutoflowAliasClaim(
            db,
            number,
            shopId,
            {
              source: "platform_admin",
              actor: resolvedBy,
            },
            session,
          );
        } catch (error) {
          if (error instanceof AutoflowAtomicClaimConflictError) {
            throw new AutoflowIdentifierConflictError(number, [
              {
                shopId: error.ownerShopId ?? "unknown",
                shopName: `Shop ${error.ownerShopId ?? "unknown"}`,
                claimType: "alias",
                field: "autoflow.shopNumbers",
                value: number,
              },
            ]);
          }
          throw error;
        }

        const update = await db.collection("shops").updateOne(
          { shopId },
          { $addToSet: { "autoflow.shopNumbers": number } },
          session ? { session } : undefined,
        );
        if (update.matchedCount !== 1) {
          throw new Error(
            `Shop ${shopId} not found while attaching AutoFlow identifier`,
          );
        }
        aliasAdded = update.modifiedCount > 0;

        await db.collection(UNRESOLVED_COLLECTION).updateOne(
          { number },
          ({
            $set: {
              resolvedShopId: shopId,
              resolvedAt: auditEntry.at,
              resolvedBy,
              reason: null,
            },
            $push: { auditTrail: auditEntry },
            $setOnInsert: { number, firstSeenAt: auditEntry.at },
          } as any),
          {
            upsert: true,
            ...(session ? { session } : {}),
          },
        );
      } catch (error) {
        if (!session && reservation) {
          let aliasRollbackSucceeded = !aliasAdded;
          if (aliasAdded) {
            try {
              await db.collection("shops").updateOne(
                { shopId, "autoflow.shopNumbers": number },
                { $pull: { "autoflow.shopNumbers": number } } as any,
              );
              aliasRollbackSucceeded = true;
            } catch (rollbackError) {
              console.error(
                "[AutoFlow Numbers] Failed to roll back alias after attach error; reservation retained for safety:",
                rollbackError,
              );
            }
          }
          if (reservation.created && aliasRollbackSucceeded) {
            await releaseAutoflowAliasClaim(
              db,
              reservation.normalizedIdentifier,
              shopId,
            );
          }
        }
        throw error;
      }
    },
  );
}

export async function detachAutoflowNumber(
  shopId: string | number,
  number: string,
  detachedBy: string | null,
): Promise<void> {
  const db = await __deps.getDb();
  const auditEntry = {
    action: "detached",
    shopId,
    actor: detachedBy,
    at: new Date(),
  };
  await withAutoflowClaimTransaction(
    () => __deps.getMongoClient(),
    async (session) => {
      let aliasRemoved = false;
      try {
        const removal = await db.collection("shops").updateOne(
          { shopId, "autoflow.shopNumbers": number },
          { $pull: { "autoflow.shopNumbers": number } } as any,
          session ? { session } : undefined,
        );
        if (removal.matchedCount !== 1) {
          throw new AutoflowAliasNotOwnedError(number, shopId);
        }
        aliasRemoved = true;

        await releaseAutoflowAliasClaim(
          db,
          normalizeAutoflowIdentifier(number),
          shopId,
          session,
        );
        // Re-open the unresolved entry so the number is visible again if the
        // extension keeps hitting it.
        await db.collection(UNRESOLVED_COLLECTION).updateOne(
          { number },
          ({
            $set: {
              resolvedShopId: null,
              resolvedAt: null,
              resolvedBy: null,
              lastDetachedAt: auditEntry.at,
              lastDetachedBy: detachedBy,
              reason: "detached_for_review",
            },
            $push: { auditTrail: auditEntry },
            $setOnInsert: { number, firstSeenAt: auditEntry.at, seenCount: 0 },
          } as any),
          {
            upsert: true,
            ...(session ? { session } : {}),
          },
        );
      } catch (error) {
        if (!session && aliasRemoved) {
          try {
            await db.collection("shops").updateOne(
              { shopId },
              { $addToSet: { "autoflow.shopNumbers": number } },
            );
            await acquireAutoflowAliasClaim(
              db,
              number,
              shopId,
              { source: "platform_admin", actor: detachedBy },
            );
          } catch (rollbackError) {
            console.error(
              "[AutoFlow Numbers] Failed to restore alias after detach error:",
              rollbackError,
            );
          }
        }
        throw error;
      }
    },
  );
}
