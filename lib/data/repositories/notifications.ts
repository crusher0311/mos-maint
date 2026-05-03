// Repository for the `notifications` collection.
import type { Collection, Filter, ObjectId as ObjectIdType } from "mongodb";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/data/db";

const COLLECTION = "notifications";

export type NotificationType =
  | "ticket_created"
  | "ticket_updated"
  | "ticket_message"
  | "ticket_resolved"
  | "system";

export interface NotificationDoc {
  _id?: ObjectIdType;
  userId: string;
  shopId?: number;
  type: NotificationType;
  title: string;
  message: string;
  link?: string;
  read: boolean;
  createdAt: Date;
  metadata?: Record<string, unknown>;
}

async function collection(): Promise<Collection<NotificationDoc>> {
  const db = await getDb();
  return db.collection<NotificationDoc>(COLLECTION);
}

export async function insertNotification(
  doc: Omit<NotificationDoc, "_id">,
): Promise<ObjectIdType> {
  const col = await collection();
  const res = await col.insertOne(doc);
  return res.insertedId;
}

export async function insertNotifications(
  docs: Array<Omit<NotificationDoc, "_id">>,
): Promise<number> {
  if (docs.length === 0) return 0;
  const col = await collection();
  const res = await col.insertMany(docs);
  return res.insertedCount;
}

export async function findForUser(
  userId: string,
  opts: { limit: number; unreadOnly: boolean },
): Promise<NotificationDoc[]> {
  const col = await collection();
  const query: Filter<NotificationDoc> = opts.unreadOnly
    ? { userId, read: false }
    : { userId };
  return col.find(query).sort({ createdAt: -1 }).limit(opts.limit).toArray();
}

export async function countUnreadForUser(userId: string): Promise<number> {
  const col = await collection();
  return col.countDocuments({ userId, read: false });
}

export async function markOneRead(
  notificationId: string,
  userId: string,
): Promise<boolean> {
  const col = await collection();
  const res = await col.updateOne(
    { _id: new ObjectId(notificationId), userId },
    { $set: { read: true } },
  );
  return res.modifiedCount > 0;
}

export async function markAllReadForUser(userId: string): Promise<number> {
  const col = await collection();
  const res = await col.updateMany(
    { userId, read: false },
    { $set: { read: true } },
  );
  return res.modifiedCount;
}

export async function deleteOneForUser(
  notificationId: string,
  userId: string,
): Promise<boolean> {
  const col = await collection();
  const res = await col.deleteOne({
    _id: new ObjectId(notificationId),
    userId,
  });
  return res.deletedCount > 0;
}

export async function findForAdmins(limit: number): Promise<NotificationDoc[]> {
  const col = await collection();
  return col
    .find({ userId: { $regex: /^admin:/ } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}

export async function countUnreadForAdmins(): Promise<number> {
  const col = await collection();
  return col.countDocuments({
    userId: { $regex: /^admin:/ },
    read: false,
  });
}

export async function markAllReadForTicket(ticketId: string): Promise<number> {
  const col = await collection();
  const res = await col.updateMany(
    { "metadata.ticketId": ticketId, read: false },
    { $set: { read: true } },
  );
  return res.modifiedCount;
}
