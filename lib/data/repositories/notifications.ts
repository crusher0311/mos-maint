// Repository for the `notifications` collection.
import type { Collection, Filter, ObjectId as ObjectIdType } from "mongodb";
import { ObjectId } from "mongodb";
import { createHash } from "node:crypto";
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

export const PLATFORM_ADMIN_INBOX_USER_ID = "platform-admin:shared";
const LEGACY_ADMIN_PREFIX = "admin:";
const LEGACY_ADMIN_USER_FILTER = { $regex: /^admin:/ };

export const __deps = { getDb };

export function getPlatformAdminLegacyKey(doc: NotificationDoc): string {
  const ticketId = typeof doc.metadata?.ticketId === "string" ? doc.metadata.ticketId : "";
  if (ticketId) {
    if (doc.type === "ticket_message" || doc.type === "ticket_updated") {
      return `${doc.type}:${ticketId}:${doc.title}:${doc.message}`;
    }
    return `${doc.type}:${ticketId}`;
  }
  return `${doc.type}:${doc.link || ""}:${doc.title}:${doc.message}`;
}

export function getPlatformAdminLogicalKey(doc: NotificationDoc): string {
  const explicitKey = doc.metadata?.platformAdminNotificationKey;
  return typeof explicitKey === "string" && explicitKey.length > 0
    ? explicitKey
    : getPlatformAdminLegacyKey(doc);
}

export function isPlatformAdminNotification(doc: Pick<NotificationDoc, "userId">): boolean {
  return doc.userId === PLATFORM_ADMIN_INBOX_USER_ID || doc.userId.startsWith(LEGACY_ADMIN_PREFIX);
}

async function collection(): Promise<Collection<NotificationDoc>> {
  const db = await __deps.getDb();
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

/** Create one idempotent, shared platform-admin inbox item. */
export async function upsertPlatformAdminNotification(
  doc: Omit<NotificationDoc, "_id" | "userId" | "read" | "createdAt"> & {
    platformAdminNotificationKey: string;
  },
): Promise<ObjectIdType> {
  const col = await collection();
  const { platformAdminNotificationKey, ...notification } = doc;
  const legacyKey = getPlatformAdminLegacyKey({
    ...notification,
    userId: PLATFORM_ADMIN_INBOX_USER_ID,
    read: false,
    createdAt: new Date(),
  });
  const metadata = {
    ...notification.metadata,
    platformAdminNotificationKey,
    platformAdminLegacyKey: legacyKey,
  };
  const existing = await col.findOne({
    userId: PLATFORM_ADMIN_INBOX_USER_ID,
    "metadata.platformAdminNotificationKey": platformAdminNotificationKey,
  });
  if (existing?._id) return existing._id;

  // Mongo already guarantees `_id` uniqueness. Deriving it from the logical
  // event key makes concurrent producer retries converge without requiring a
  // new production index or a migration of legacy rows.
  const deterministicId = new ObjectId(
    createHash("sha256")
      .update(`${PLATFORM_ADMIN_INBOX_USER_ID}:${platformAdminNotificationKey}`)
      .digest("hex")
      .slice(0, 24),
  );
  const result = await col.findOneAndUpdate(
    { _id: deterministicId },
    {
      $setOnInsert: {
        ...notification,
        userId: PLATFORM_ADMIN_INBOX_USER_ID,
        read: false,
        createdAt: new Date(),
        metadata,
      },
    },
    { upsert: true, returnDocument: "after" },
  );
  return result!._id!;
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

export async function findForAdmins(limit: number, unreadOnly = false): Promise<NotificationDoc[]> {
  const col = await collection();
  const rows = await col.find({
    $or: [
      { userId: PLATFORM_ADMIN_INBOX_USER_ID },
      { userId: LEGACY_ADMIN_USER_FILTER },
    ],
  }).sort({ createdAt: -1 }).toArray();
  const sharedByLegacyKey = new Map<string, string>();
  for (const row of rows) {
    if (row.userId !== PLATFORM_ADMIN_INBOX_USER_ID) continue;
    const compatibilityKey = typeof row.metadata?.platformAdminLegacyKey === "string"
      ? row.metadata.platformAdminLegacyKey
      : getPlatformAdminLegacyKey(row);
    if (!sharedByLegacyKey.has(compatibilityKey)) {
      sharedByLegacyKey.set(compatibilityKey, getPlatformAdminLogicalKey(row));
    }
  }
  const grouped = new Map<string, NotificationDoc[]>();
  for (const row of rows) {
    const legacyKey = getPlatformAdminLegacyKey(row);
    const key = row.userId === PLATFORM_ADMIN_INBOX_USER_ID
      ? getPlatformAdminLogicalKey(row)
      : sharedByLegacyKey.get(legacyKey) || legacyKey;
    const group = grouped.get(key) || [];
    group.push(row);
    grouped.set(key, group);
  }
  return [...grouped.values()]
    .map((group) => {
      const representative = group.find((row) => row.userId === PLATFORM_ADMIN_INBOX_USER_ID) || group[0];
      return { ...representative, read: group.every((row) => row.read) };
    })
    .filter((row) => !unreadOnly || !row.read)
    .slice(0, limit);
}

export async function countUnreadForAdmins(): Promise<number> {
  return (await findForAdmins(Number.MAX_SAFE_INTEGER, true)).length;
}

async function adminLogicalFilter(notificationId: string): Promise<Filter<NotificationDoc> | null> {
  const col = await collection();
  const notification = await col.findOne({ _id: new ObjectId(notificationId) });
  if (!notification || !isPlatformAdminNotification(notification)) {
    return null;
  }
  const key = getPlatformAdminLogicalKey(notification);
  const compatibilityKey = typeof notification.metadata?.platformAdminLegacyKey === "string"
    ? notification.metadata.platformAdminLegacyKey
    : getPlatformAdminLegacyKey(notification);
  const legacyRows = await col.find({ userId: LEGACY_ADMIN_USER_FILTER }).toArray();
  const legacyIds = legacyRows
    .filter((row) => getPlatformAdminLegacyKey(row) === compatibilityKey)
    .map((row) => row._id!)
    .filter(Boolean);
  if (notification.userId === PLATFORM_ADMIN_INBOX_USER_ID) {
    const related: Filter<NotificationDoc>[] = [
      { userId: PLATFORM_ADMIN_INBOX_USER_ID, "metadata.platformAdminNotificationKey": key },
    ];
    if (legacyIds.length > 0) related.push({ _id: { $in: legacyIds } });
    return { $or: related };
  }
  return {
    $or: [
      { _id: { $in: legacyIds } },
      { userId: PLATFORM_ADMIN_INBOX_USER_ID, "metadata.platformAdminLegacyKey": compatibilityKey },
      { userId: PLATFORM_ADMIN_INBOX_USER_ID, "metadata.platformAdminNotificationKey": key },
    ],
  };
}

export async function markOneAdminNotificationRead(notificationId: string): Promise<boolean> {
  const col = await collection();
  const filter = await adminLogicalFilter(notificationId);
  if (!filter) return false;
  const result = await col.updateMany({ ...filter, read: false }, { $set: { read: true } });
  return result.modifiedCount > 0;
}

export async function deleteOneAdminNotification(notificationId: string): Promise<boolean> {
  const col = await collection();
  const filter = await adminLogicalFilter(notificationId);
  if (!filter) return false;
  const result = await col.deleteMany(filter);
  return result.deletedCount > 0;
}

export async function markAllAdminNotificationsRead(): Promise<number> {
  const col = await collection();
  const result = await col.updateMany(
    { $or: [{ userId: PLATFORM_ADMIN_INBOX_USER_ID }, { userId: LEGACY_ADMIN_USER_FILTER }], read: false },
    { $set: { read: true } },
  );
  return result.modifiedCount;
}

export async function markAllReadForTicket(ticketId: string): Promise<number> {
  const col = await collection();
  const res = await col.updateMany(
    { "metadata.ticketId": ticketId, read: false },
    { $set: { read: true } },
  );
  return res.modifiedCount;
}
