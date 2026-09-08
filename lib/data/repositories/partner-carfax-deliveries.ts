import type { ClientSession, Db } from "mongodb";
import { getDb, getMongoClient } from "@/lib/mongo";
import { randomUUID } from "crypto";

export const __deps = { getDb, getMongoClient };

export type PartnerCarfaxDeliveryKey = {
  partnerId: string;
  shopId: number;
  deliveryId: string;
};

const DELIVERY_LEASE_MS = 2 * 60 * 1000;

function filterFor(key: PartnerCarfaxDeliveryKey) {
  return {
    _id: `${key.partnerId}:${key.shopId}:${key.deliveryId}`,
    ...key,
  };
}

export async function findPartnerCarfaxDelivery(key: PartnerCarfaxDeliveryKey) {
  const db = await __deps.getDb();
  return db.collection<any>("partner_carfax_deliveries").findOne(filterFor(key));
}

export async function claimPartnerCarfaxDelivery(
  key: PartnerCarfaxDeliveryKey,
  details: { vin: string; retrievedAt: Date },
): Promise<string | null> {
  const db = await __deps.getDb();
  const filter = filterFor(key);
  const ownerToken = randomUUID();
  try {
    const result = await db.collection<any>("partner_carfax_deliveries").updateOne(
      filter,
      {
        $setOnInsert: {
          ...filter,
          ...details,
          status: "processing",
          ownerToken,
          leaseUntil: new Date(Date.now() + DELIVERY_LEASE_MS),
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );
    return result.upsertedCount === 1 ? ownerToken : null;
  } catch (error: any) {
    if (error?.code === 11000) return null;
    throw error;
  }
}

export async function reclaimExpiredPartnerCarfaxDelivery(
  key: PartnerCarfaxDeliveryKey,
): Promise<string | null> {
  const db = await __deps.getDb();
  const ownerToken = randomUUID();
  const result = await db.collection<any>("partner_carfax_deliveries").updateOne(
    {
      ...filterFor(key),
      status: "processing",
      leaseUntil: { $lte: new Date() },
    },
    {
      $set: {
        ownerToken,
        leaseUntil: new Date(Date.now() + DELIVERY_LEASE_MS),
        reclaimedAt: new Date(),
      },
    },
  );
  return result.modifiedCount === 1 ? ownerToken : null;
}

export async function executeOwnedPartnerCarfaxDelivery<T>(
  key: PartnerCarfaxDeliveryKey,
  ownerToken: string,
  work: (
    db: Db,
    session: ClientSession,
  ) => Promise<{
    stored: boolean;
    outcome?: string;
    cacheInvalidationPending?: boolean;
    value: T;
  }>,
): Promise<T | null> {
  const client = await __deps.getMongoClient();
  const session = client.startSession();
  let value: T | null = null;
  try {
    await session.withTransaction(async () => {
      const db = await __deps.getDb();
      const owned = await db.collection<any>("partner_carfax_deliveries").findOne(
        {
          ...filterFor(key),
          ownerToken,
          status: "processing",
          leaseUntil: { $gt: new Date() },
        },
        { session },
      );
      if (!owned) return;
      const result = await work(db, session);
      const completed = await db.collection<any>("partner_carfax_deliveries").updateOne(
        { ...filterFor(key), ownerToken, status: "processing" },
        {
          $set: {
            stored: result.stored,
            outcome: result.outcome,
            cacheInvalidationPending: result.cacheInvalidationPending === true,
            status: "completed",
            completedAt: new Date(),
          },
        },
        { session },
      );
      if (completed.matchedCount !== 1) {
        throw new Error("Partner CARFAX delivery ownership was lost");
      }
      value = result.value;
    });
    return value;
  } finally {
    await session.endSession();
  }
}

/**
 * Clears the durable retry marker only after the VIN-scoped derived caches
 * were successfully invalidated. A crashed/failed post-commit invalidation is
 * therefore retried by the next duplicate delivery request.
 */
export async function completePartnerCarfaxCacheInvalidation(
  key: PartnerCarfaxDeliveryKey,
): Promise<void> {
  const db = await __deps.getDb();
  await db.collection<any>("partner_carfax_deliveries").updateOne(
    { ...filterFor(key), status: "completed", cacheInvalidationPending: true },
    { $set: { cacheInvalidationPending: false, cacheInvalidatedAt: new Date() } },
  );
}

export async function releasePartnerCarfaxDelivery(
  key: PartnerCarfaxDeliveryKey,
  ownerToken: string,
) {
  const db = await __deps.getDb();
  await db.collection<any>("partner_carfax_deliveries").deleteOne({
    ...filterFor(key),
    ownerToken,
    status: "processing",
  });
}