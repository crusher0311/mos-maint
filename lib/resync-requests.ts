import "server-only";
import type { Db, ObjectId } from "mongodb";

// Customer-requested re-sync queue (task #629 follow-on).
//
// A shop user who suspects their synced history is incomplete can ask for a
// full re-sync. We deliberately do NOT run the backfill immediately — that
// would hammer the shared database during business hours. Instead we record a
// queued request here and let the overnight `daily-all` cron drain it via
// `/api/cron/process-resync-requests`, so the heavy work lands when the
// background workers are active and shops are quiet.

export const RESYNC_REQUESTS_COLLECTION = "resync_requests";

export type ResyncStatus = "queued" | "processing" | "completed" | "failed";
export type ResyncSource = "customer" | "admin";

export interface ResyncRequest {
  _id?: ObjectId;
  shopId: number;
  status: ResyncStatus;
  source: ResyncSource;
  requestedBy: string | null;
  requestedAt: Date;
  scheduledFor: Date;
  provider: string | null;
  processingStartedAt?: Date | null;
  processedAt?: Date | null;
  error?: string | null;
}

// Customers may only queue one re-sync per shop per cooldown window. A
// platform admin acting on a shop bypasses this throttle.
export const RESYNC_COOLDOWN_MS = 12 * 60 * 60 * 1000;

// Informational ETA shown to the user ("scheduled for tonight"). The actual
// run happens whenever the overnight daily-all cron next drains the queue.
export function nextOvernightWindow(now = new Date()): Date {
  const d = new Date(now);
  d.setHours(2, 0, 0, 0);
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

export async function getLatestResyncRequest(
  db: Db,
  shopId: number,
): Promise<ResyncRequest | null> {
  const rows = await db
    .collection<ResyncRequest>(RESYNC_REQUESTS_COLLECTION)
    .find({ shopId })
    .sort({ requestedAt: -1 })
    .limit(1)
    .toArray();
  return rows[0] ?? null;
}

export interface QueueResult {
  ok: boolean;
  status: "queued" | "already_queued" | "cooldown" | "no_integration";
  request: ResyncRequest | null;
  retryAfter?: Date;
}

export async function queueResyncRequest(
  db: Db,
  opts: {
    shopId: number;
    provider: string | null;
    requestedBy: string | null;
    source: ResyncSource;
  },
): Promise<QueueResult> {
  const { shopId, provider, requestedBy, source } = opts;
  const coll = db.collection<ResyncRequest>(RESYNC_REQUESTS_COLLECTION);

  const latest = await getLatestResyncRequest(db, shopId);

  // Already pending — return the existing request (idempotent).
  if (latest && (latest.status === "queued" || latest.status === "processing")) {
    return { ok: true, status: "already_queued", request: latest };
  }

  // Throttle repeat customer requests; admins are exempt.
  if (
    source === "customer" &&
    latest &&
    latest.status === "completed" &&
    latest.processedAt
  ) {
    const elapsed = Date.now() - new Date(latest.processedAt).getTime();
    if (elapsed < RESYNC_COOLDOWN_MS) {
      return {
        ok: false,
        status: "cooldown",
        request: latest,
        retryAfter: new Date(
          new Date(latest.processedAt).getTime() + RESYNC_COOLDOWN_MS,
        ),
      };
    }
  }

  const now = new Date();
  const doc: ResyncRequest = {
    shopId,
    status: "queued",
    source,
    requestedBy,
    requestedAt: now,
    scheduledFor: nextOvernightWindow(now),
    provider,
    processingStartedAt: null,
    processedAt: null,
    error: null,
  };

  const res = await coll.insertOne(doc as ResyncRequest);
  return {
    ok: true,
    status: "queued",
    request: { ...doc, _id: res.insertedId },
  };
}

// Atomically claim the oldest queued request (queued -> processing) so
// concurrent cron instances never double-trigger the same shop.
export async function claimNextQueuedRequest(
  db: Db,
): Promise<ResyncRequest | null> {
  const doc = await db
    .collection<ResyncRequest>(RESYNC_REQUESTS_COLLECTION)
    .findOneAndUpdate(
      { status: "queued" },
      { $set: { status: "processing", processingStartedAt: new Date() } },
      { sort: { requestedAt: 1 }, returnDocument: "after" },
    );
  // mongodb v6 returns the document directly (or null).
  return (doc as ResyncRequest | null) ?? null;
}

export async function markResyncCompleted(
  db: Db,
  id: ObjectId,
  provider: string | null,
): Promise<void> {
  await db
    .collection<ResyncRequest>(RESYNC_REQUESTS_COLLECTION)
    .updateOne(
      { _id: id },
      {
        $set: {
          status: "completed",
          provider,
          processedAt: new Date(),
          error: null,
        },
      },
    );
}

export async function markResyncFailed(
  db: Db,
  id: ObjectId,
  error: string,
): Promise<void> {
  await db
    .collection<ResyncRequest>(RESYNC_REQUESTS_COLLECTION)
    .updateOne(
      { _id: id },
      { $set: { status: "failed", processedAt: new Date(), error } },
    );
}
