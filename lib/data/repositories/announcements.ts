// Repository for the `system_announcements` collection.
import type { Collection, Filter, ObjectId as ObjectIdType, UpdateFilter } from "mongodb";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/data/db";

const COLLECTION = "system_announcements";

export interface AnnouncementDoc {
  _id?: ObjectIdType;
  title: string;
  message: string;
  priority: "info" | "warning" | "critical";
  target: {
    type: "all" | "shops" | "roles" | "sms_integration";
    shopIds?: number[];
    roles?: string[];
    smsIntegrations?: string[];
  };
  deliveryChannels: { inApp: boolean; email: boolean };
  status: "draft" | "sent" | "scheduled";
  createdBy: string;
  createdAt: Date;
  sentAt?: Date;
  expiresAt?: Date;
  stats?: {
    totalRecipients: number;
    emailsSent: number;
    inAppSent: number;
  };
}

async function collection(): Promise<Collection<AnnouncementDoc>> {
  const db = await getDb();
  return db.collection<AnnouncementDoc>(COLLECTION);
}

export async function insertAnnouncement(
  doc: Omit<AnnouncementDoc, "_id">,
): Promise<ObjectIdType> {
  const col = await collection();
  const res = await col.insertOne(doc);
  return res.insertedId;
}

export async function listAnnouncements(
  limit: number,
  query: Filter<AnnouncementDoc> = {},
  sort: Record<string, 1 | -1> = { createdAt: -1 },
): Promise<AnnouncementDoc[]> {
  const col = await collection();
  return col.find(query).sort(sort).limit(limit).toArray();
}

export async function findAnnouncementById(id: string): Promise<AnnouncementDoc | null> {
  const col = await collection();
  return col.findOne({ _id: new ObjectId(id) });
}

export async function updateAnnouncementById(
  id: string,
  update: UpdateFilter<AnnouncementDoc>,
): Promise<boolean> {
  const col = await collection();
  const res = await col.updateOne({ _id: new ObjectId(id) }, update);
  return res.modifiedCount > 0;
}

export async function deleteAnnouncementById(id: string): Promise<boolean> {
  const col = await collection();
  const res = await col.deleteOne({ _id: new ObjectId(id) });
  return res.deletedCount > 0;
}
