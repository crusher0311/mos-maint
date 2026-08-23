// Repository for `enterprise_accounts` and `recommendation_events`.
import type { Collection, Document, Filter, ObjectId as ObjectIdType } from "mongodb";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/data/db";

const ENTERPRISE_COLLECTION = "enterprise_accounts";
const EVENTS_COLLECTION = "recommendation_events";

export interface EnterpriseAccountDoc {
  _id?: ObjectIdType;
  name: string;
  shopIds: number[];
  sharedMappings?: {
    cannedJobs: Record<string, string>;
    updatedAt: Date;
  };
  sharedIntegrations?: {
    protractor?: { baseUrl: string; apiKey: string };
    tekmetric?: { shopId: number };
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface RecommendationEventDoc {
  _id?: ObjectIdType;
  shopId: number;
  enterpriseId?: ObjectIdType;
  vin: string;
  vehicleId?: string;
  workOrderId: string;
  workOrderNumber?: string;
  provider: "protractor" | "tekmetric";
  eventType: "recommendation_added" | "recommendation_sold";
  recommendationType: "oem" | "dvi" | "carfax" | "shop" | "protractor";
  serviceCode?: string;
  serviceName: string;
  lineItemId?: string;
  price?: number;
  laborPrice?: number;
  partsPrice?: number;
  totalPrice?: number;
  addedBy?: string;
  createdAt: Date;
}

function toObjectId(id: ObjectIdType | string): ObjectIdType {
  return typeof id === "string" ? new ObjectId(id) : id;
}

async function enterpriseCollection(): Promise<Collection<EnterpriseAccountDoc>> {
  const db = await getDb();
  return db.collection<EnterpriseAccountDoc>(ENTERPRISE_COLLECTION);
}

async function eventsCollection(): Promise<Collection<RecommendationEventDoc>> {
  const db = await getDb();
  return db.collection<RecommendationEventDoc>(EVENTS_COLLECTION);
}

export async function findEnterpriseById(
  id: ObjectIdType | string,
): Promise<EnterpriseAccountDoc | null> {
  const col = await enterpriseCollection();
  return col.findOne({ _id: toObjectId(id) });
}

export async function findEnterpriseByShopId(
  shopId: number,
): Promise<EnterpriseAccountDoc | null> {
  // Some legacy docs store shopIds as strings; the $in spans both shapes.
  const col = await enterpriseCollection();
  return col.findOne({
    shopIds: { $in: [Number(shopId), String(shopId)] },
  } as Filter<EnterpriseAccountDoc>);
}

export async function insertEnterprise(
  doc: Omit<EnterpriseAccountDoc, "_id">,
): Promise<ObjectIdType> {
  const col = await enterpriseCollection();
  const res = await col.insertOne(doc);
  return res.insertedId;
}

export async function addShopToEnterprise(
  enterpriseId: ObjectIdType | string,
  shopId: number,
) {
  const col = await enterpriseCollection();
  return col.updateOne(
    { _id: toObjectId(enterpriseId) },
    { $addToSet: { shopIds: shopId }, $set: { updatedAt: new Date() } },
  );
}

export async function removeShopFromEnterprise(
  enterpriseId: ObjectIdType | string,
  shopId: number,
) {
  const col = await enterpriseCollection();
  return col.updateOne(
    { _id: toObjectId(enterpriseId) },
    { $pull: { shopIds: shopId }, $set: { updatedAt: new Date() } },
  );
}

export async function insertRecommendationEvent(
  doc: Omit<RecommendationEventDoc, "_id">,
): Promise<ObjectIdType> {
  // Task #998: recommendation_events is a durable store in the plan-cache
  // family. When PLAN_CACHE_PG_CANONICAL=1, PG is the canonical insert and
  // Mongo becomes the (still-awaited, for the ObjectId return contract)
  // shadow; pre-flip, Mongo stays canonical with a best-effort PG mirror.
  const { isPlanCachePgCanonical } = await import("@/lib/db/plan-cache-write-mode");
  const col = await eventsCollection();
  const res = await col.insertOne(doc);
  try {
    const { recordRecommendationEventPg } = await import(
      "@/lib/data/repositories/plan-cache-store"
    );
    await recordRecommendationEventPg({ ...doc, _id: res.insertedId });
  } catch (err) {
    if (isPlanCachePgCanonical()) throw err;
    console.warn(
      "[RecommendationEvents] PG mirror insert failed (non-fatal pre-cutover):",
      (err as Error)?.message,
    );
  }
  return res.insertedId;
}

export async function findRecommendationEvent(
  filter: Filter<RecommendationEventDoc>,
): Promise<RecommendationEventDoc | null> {
  const col = await eventsCollection();
  return col.findOne(filter);
}

export async function listRecommendationEvents(
  filter: Filter<RecommendationEventDoc>,
): Promise<RecommendationEventDoc[]> {
  const col = await eventsCollection();
  return col.find(filter).toArray();
}

export async function aggregateRecommendationEvents<T extends Document = Document>(
  pipeline: Document[],
): Promise<T[]> {
  const col = await eventsCollection();
  return col.aggregate<T>(pipeline).toArray();
}
