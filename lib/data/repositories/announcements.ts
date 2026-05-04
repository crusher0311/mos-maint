// Repository for the `system_announcements` collection.
//
// Wave 1 (task #342): reads now come from Postgres; the Mongo collection is
// kept as a best-effort dual-write target until the soak window passes
// (see docs/db-migration-map.md §3.8).
import type { Collection, Filter, ObjectId as ObjectIdType, UpdateFilter } from "mongodb";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/data/db";
import {
  pgInsertAnnouncement,
  pgListAnnouncements,
  pgFindAnnouncement,
  pgUpdateAnnouncement,
  pgDeleteAnnouncement,
  type AnnouncementListOptions,
  type AnnouncementRow,
} from "@/lib/db/repositories/wave1";

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

function pgRowToDoc(row: AnnouncementRow): AnnouncementDoc {
  // The Mongo `_id` is an ObjectId; PG keeps the same hex string in `id`.
  // For rows that originated in PG (e.g., a future PG-only insert path)
  // the id may not be a valid ObjectId — in that case we generate a
  // fresh ObjectId so the AnnouncementDoc invariant holds. The original
  // PG id is preserved in the announcements table itself.
  const objectId = ObjectId.isValid(row.id) ? new ObjectId(row.id) : new ObjectId();
  return {
    _id: objectId,
    title: row.title,
    message: row.message,
    priority: row.priority as AnnouncementDoc["priority"],
    target: row.target as AnnouncementDoc["target"],
    deliveryChannels: row.deliveryChannels as AnnouncementDoc["deliveryChannels"],
    status: row.status as AnnouncementDoc["status"],
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    sentAt: row.sentAt ?? undefined,
    expiresAt: row.expiresAt ?? undefined,
    stats: (row.stats ?? undefined) as AnnouncementDoc["stats"],
  };
}

export async function insertAnnouncement(
  doc: Omit<AnnouncementDoc, "_id">,
): Promise<ObjectIdType> {
  const id = new ObjectId();
  // PG canonical write — must succeed.
  await pgInsertAnnouncement({
    id: id.toString(),
    title: doc.title,
    message: doc.message,
    priority: doc.priority,
    target: doc.target,
    deliveryChannels: doc.deliveryChannels,
    status: doc.status,
    createdBy: doc.createdBy,
    createdAt: doc.createdAt,
    sentAt: doc.sentAt ?? null,
    expiresAt: doc.expiresAt ?? null,
    stats: doc.stats ?? null,
  });
  // Mongo legacy mirror (best-effort, retained for W1.5 soak only).
  try {
    const col = await collection();
    await col.insertOne({ _id: id, ...doc });
  } catch (err) {
    console.error("[announcements] Mongo mirror failed (non-fatal):", err);
  }
  return id;
}

export async function listAnnouncements(
  limit: number,
  query: Filter<AnnouncementDoc> = {},
  sort: Record<string, 1 | -1> = { createdAt: -1 },
): Promise<AnnouncementDoc[]> {
  const opts: AnnouncementListOptions = {};
  const q = query as Record<string, unknown>;
  if (typeof q.status === "string") opts.status = q.status;

  // Translate Mongo-style { $or: [{expiresAt:{$exists:false}},{expiresAt:{$gt:now}}] }
  // into the repo's `notExpiredAt` predicate.
  if (Array.isArray(q.$or)) {
    for (const clause of q.$or as Record<string, unknown>[]) {
      const exp = clause.expiresAt as Record<string, unknown> | undefined;
      if (exp && typeof exp === "object" && "$gt" in exp && exp.$gt instanceof Date) {
        opts.notExpiredAt = exp.$gt;
        break;
      }
    }
  }

  const sortField = "sentAt" in sort ? "sentAt" : "createdAt";
  const sortDirection = sort[sortField] === 1 ? "asc" : "desc";
  opts.sortField = sortField as "sentAt" | "createdAt";
  opts.sortDirection = sortDirection;

  const rows = await pgListAnnouncements(limit, opts);
  return rows.map(pgRowToDoc);
}

/**
 * Convenience reader for the in-app banner. Returns sent + non-expired
 * announcements, newest first by `sentAt`.
 */
export async function listActiveAnnouncements(limit: number): Promise<AnnouncementDoc[]> {
  const rows = await pgListAnnouncements(limit, {
    status: "sent",
    notExpiredAt: new Date(),
    sortField: "sentAt",
    sortDirection: "desc",
  });
  return rows.map(pgRowToDoc);
}

export async function findAnnouncementById(id: string): Promise<AnnouncementDoc | null> {
  const row = await pgFindAnnouncement(id);
  return row ? pgRowToDoc(row) : null;
}

export async function updateAnnouncementById(
  id: string,
  update: UpdateFilter<AnnouncementDoc>,
): Promise<boolean> {
  const u = update as { $set?: Partial<AnnouncementRow> };
  const set = (u.$set ?? (update as Partial<AnnouncementRow>));
  await pgUpdateAnnouncement(id, set);
  try {
    const col = await collection();
    await col.updateOne({ _id: new ObjectId(id) }, update);
  } catch (err) {
    console.error("[announcements] Mongo update mirror failed:", err);
  }
  return true;
}

export async function deleteAnnouncementById(id: string): Promise<boolean> {
  await pgDeleteAnnouncement(id);
  try {
    const col = await collection();
    await col.deleteOne({ _id: new ObjectId(id) });
  } catch (err) {
    console.error("[announcements] Mongo delete mirror failed:", err);
  }
  return true;
}
