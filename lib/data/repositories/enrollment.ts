// Repository for enrollment-code self-signup data access
// (shop enrollment config, join signups, pending-approval users).
import type { Document } from "mongodb";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/data/db";

// Legacy shop docs are keyed by string OR numeric shopId (see
// lib/data/repositories/shops.ts). Match both.
function shopIdFilter(shopId: number | string) {
  return { $or: [{ shopId: Number(shopId) }, { shopId: String(shopId) }] };
}

export async function findShopEnrollmentByShopId(shopId: number): Promise<Document | null> {
  const db = await getDb();
  return db.collection("shops").findOne(
    shopIdFilter(shopId),
    { projection: { shopId: 1, name: 1, enrollment: 1 } },
  );
}

export async function findShopByEnrollmentCode(code: string): Promise<Document | null> {
  const db = await getDb();
  return db.collection("shops").findOne(
    { "enrollment.code": code },
    { projection: { shopId: 1, name: 1, locationIdentifier: 1, enrollment: 1 } },
  );
}

export async function findShopNameByShopId(shopId: number): Promise<Document | null> {
  const db = await getDb();
  return db.collection("shops").findOne(shopIdFilter(shopId), { projection: { name: 1 } });
}

/** $set dot-path fields on the shop's enrollment subdoc. Returns matchedCount. */
export async function setShopEnrollmentFields(
  shopId: number,
  set: Record<string, unknown>,
): Promise<number> {
  const db = await getDb();
  const result = await db.collection("shops").updateOne(shopIdFilter(shopId), { $set: set });
  return result.matchedCount;
}

export async function findUserByEmailLower(emailLower: string): Promise<Document | null> {
  const db = await getDb();
  return db.collection("users").findOne({ emailLower }, { projection: { _id: 1 } });
}

export async function insertEnrollmentUser(doc: Document): Promise<ObjectId> {
  const db = await getDb();
  const result = await db.collection("users").insertOne(doc);
  return result.insertedId;
}

export async function insertEnrollmentSession(doc: Document): Promise<void> {
  const db = await getDb();
  await db.collection("sessions").insertOne(doc);
}

export async function findUserById(id: ObjectId): Promise<Document | null> {
  const db = await getDb();
  return db.collection("users").findOne({ _id: id });
}

export async function deleteUserByObjectId(id: ObjectId): Promise<void> {
  const db = await getDb();
  await db.collection("users").deleteOne({ _id: id });
}

export async function approvePendingUser(id: ObjectId, approvedBy: string): Promise<void> {
  const db = await getDb();
  const now = new Date();
  await db.collection("users").updateOne(
    { _id: id },
    {
      $unset: { status: "", pendingSince: "" },
      $set: { approvedAt: now, approvedBy, updatedAt: now },
    },
  );
}
