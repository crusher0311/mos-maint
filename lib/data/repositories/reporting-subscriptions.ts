import { ObjectId, type Document } from "mongodb";
import { getDb } from "@/lib/data/db";

const COLLECTION = "reporting_subscriptions";

export interface ReportingSubscriptionDocument extends Document {
  _id: ObjectId;
  createdBy: string;
  recipientEmail: string;
  cadence: "weekly" | "monthly";
  timezone: string;
  sendHour: number;
  dayOfWeek?: number;
  dayOfMonth?: number;
  scope: { kind: "shop" | "enterprise" | "platform"; shopId?: number; enterpriseId?: string };
  filters?: { locationId?: number; advisorKey?: string; technicianKey?: string };
  paused: boolean;
  disableTokenHash: string;
  disableToken: string;
  nextRunAt: Date;
  lastRunAt?: Date;
  lastStatus?: string;
  lastError?: string;
  deliveryHistory: Array<{ key: string; at: Date; status: string; error?: string }>;
  createdAt: Date;
  updatedAt: Date;
  processingKey?: string;
  processingAt?: Date;
}

async function collection() {
  return (await getDb()).collection<ReportingSubscriptionDocument>(COLLECTION);
}

export async function createReportingSubscription(
  doc: Omit<ReportingSubscriptionDocument, "_id">,
) {
  const result = await (await collection()).insertOne(doc as ReportingSubscriptionDocument);
  return { ...doc, _id: result.insertedId };
}

export async function listReportingSubscriptions(actorEmail: string, platform = false) {
  return (await collection())
    .find(platform ? {} : { createdBy: actorEmail.toLowerCase() })
    .sort({ createdAt: -1 })
    .limit(200)
    .toArray();
}

export async function findReportingSubscription(id: string) {
  if (!ObjectId.isValid(id)) return null;
  return (await collection()).findOne({ _id: new ObjectId(id) });
}

export async function updateReportingSubscription(id: string, update: Partial<ReportingSubscriptionDocument>) {
  if (!ObjectId.isValid(id)) return null;
  return (await collection()).findOneAndUpdate(
    { _id: new ObjectId(id) },
    { $set: { ...update, updatedAt: new Date() } },
    { returnDocument: "after" },
  );
}

export async function deleteReportingSubscription(id: string) {
  if (!ObjectId.isValid(id)) return false;
  return (await collection()).deleteOne({ _id: new ObjectId(id) }).then((r) => r.deletedCount === 1);
}

export async function disableReportingSubscriptionByToken(tokenHash: string) {
  return (await collection()).findOneAndUpdate(
    { disableTokenHash: tokenHash },
    { $set: { paused: true, lastStatus: "unsubscribed", updatedAt: new Date() } },
    { returnDocument: "after" },
  );
}

export async function findReportingRecipient(email: string) {
  const emailLower = email.trim().toLowerCase();
  return (await getDb()).collection("users").findOne(
    { $or: [{ emailLower }, { email: emailLower }] },
    { projection: { email: 1, emailLower: 1, shopId: 1, role: 1, isPlatformAdmin: 1, status: 1, active: 1 } },
  );
}

export async function claimDueReportingSubscriptions(now: Date, limit = 25) {
  const ids = await (await collection()).find({
    paused: false,
    nextRunAt: { $lte: now },
    $or: [{ processingAt: { $exists: false } }, { processingAt: { $lt: new Date(now.getTime() - 30 * 60000) } }],
  }).sort({ nextRunAt: 1 }).limit(limit).project({ _id: 1 }).toArray();
  const claimed: ReportingSubscriptionDocument[] = [];
  for (const { _id } of ids) {
    const key = `${_id}:${now.toISOString().slice(0, 13)}`;
    const doc = await (await collection()).findOneAndUpdate(
      {
        _id,
        paused: false,
        nextRunAt: { $lte: now },
        "deliveryHistory.key": { $ne: key },
        $or: [{ processingAt: { $exists: false } }, { processingAt: { $lt: new Date(now.getTime() - 30 * 60000) } }],
      },
      { $set: { processingKey: key, processingAt: now } },
      { returnDocument: "after" },
    );
    if (doc) claimed.push(doc);
  }
  return claimed;
}

export async function completeReportingDelivery(
  id: ObjectId,
  key: string,
  status: "sent" | "failed" | "access_revoked",
  nextRunAt: Date,
  error?: string,
  pause = false,
) {
  await (await collection()).updateOne(
    { _id: id, processingKey: key },
    {
      $set: {
        lastRunAt: new Date(),
        lastStatus: status,
        lastError: error || "",
        nextRunAt,
        updatedAt: new Date(),
        ...(pause ? { paused: true } : {}),
      },
      $unset: { processingKey: "", processingAt: "" },
      $push: {
        deliveryHistory: {
          $each: [{ key, at: new Date(), status, ...(error ? { error: error.slice(0, 500) } : {}) }],
          $slice: -30,
        },
      },
    } as any,
  );
}