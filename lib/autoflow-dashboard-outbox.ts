import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { bumpDashboardUpdate } from "@/lib/dashboard-updates";

export type AutoflowDashboardUpdateSource =
  | "autoflow_webhook"
  | "autoflow_workflow";

type OutboxStatus = "prepared" | "ready" | "terminal";

interface OutboxIntent {
  _id: string;
  shopId: string;
  source: AutoflowDashboardUpdateSource;
  status: OutboxStatus;
  finalized: boolean;
  attempts: number;
  createdAt: Date;
  dueAt: Date;
  leaseToken?: string;
  leaseUntil?: Date;
}

const COLLECTION = "autoflow_dashboard_update_outbox";
const DB_TIMEOUT_MS = 2_000;
const PREPARED_GRACE_MS = 60_000;
const LEASE_MS = 30_000;
const MAX_ATTEMPTS = 8;
const MAX_BATCH = 25;
const DRAIN_BUDGET_MS = 20_000;
const INTENT_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const TERMINAL_RETENTION_SECONDS = 7 * 24 * 60 * 60;
// maxTimeMS bounds server execution; timeoutMS additionally bounds checkout,
// server selection, and network waiting in MongoDB drivers that support CSOT.
const BOUNDED_DB_OPTIONS = {
  maxTimeMS: DB_TIMEOUT_MS,
  timeoutMS: DB_TIMEOUT_MS,
} as const;

/**
 * Mutable only for deterministic tests. Production callers must not replace
 * these dependencies.
 */
export const __deps: {
  now: () => number;
  bumpDashboardUpdate: typeof bumpDashboardUpdate;
} = {
  now: () => Date.now(),
  bumpDashboardUpdate,
};

/*
 * Index initialization is deliberately cached by Db, rather than globally:
 * applications can have more than one Mongo database. A rejected initialization
 * is removed from the cache so a transient index-build failure is retried.
 */
const indexInitializations = new WeakMap<Db, Promise<void>>();

function initializeIndexes(db: Db): Promise<void> {
  const cached = indexInitializations.get(db);
  if (cached) return cached;

  const collection = db.collection(COLLECTION);
  const initialization = Promise.all([
    collection.createIndex(
      { status: 1, dueAt: 1, leaseUntil: 1, attempts: 1, createdAt: 1 },
      { name: "status_due_lease_attempt_created", ...BOUNDED_DB_OPTIONS },
    ),
    collection.createIndex(
      { terminalAt: 1 },
      {
        name: "terminal_ttl",
        expireAfterSeconds: TERMINAL_RETENTION_SECONDS,
        ...BOUNDED_DB_OPTIONS,
      },
    ),
  ]).then(() => undefined);

  indexInitializations.set(db, initialization);
  void initialization.catch(() => {
    if (indexInitializations.get(db) === initialization) {
      indexInitializations.delete(db);
    }
  });
  return initialization;
}

function normalizeShopId(shopId: string | number): string {
  if (typeof shopId === "number") {
    if (!Number.isSafeInteger(shopId) || shopId <= 0) {
      throw new TypeError("shopId must be a positive integer");
    }
    return String(shopId);
  }
  if (typeof shopId !== "string" || !/^[1-9]\d*$/.test(shopId)) {
    throw new TypeError("shopId must be a positive integer");
  }
  const numeric = BigInt(shopId);
  if (numeric > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError("shopId must be a safe positive integer");
  }
  return numeric.toString();
}

function validateSource(source: string): asserts source is AutoflowDashboardUpdateSource {
  if (source !== "autoflow_webhook" && source !== "autoflow_workflow") {
    throw new TypeError("source must be autoflow_webhook or autoflow_workflow");
  }
}

function backoffMs(attempts: number): number {
  return Math.min(60 * 60 * 1_000, 60_000 * 2 ** Math.max(0, attempts - 1));
}

function unwrapFindOneAndUpdate<T>(result: T | { value?: T | null } | null): T | null {
  if (result && typeof result === "object" && "value" in result) {
    return result.value ?? null;
  }
  return (result as T | null) ?? null;
}

/**
 * Write-ahead half of the contract. Call this and await it BEFORE persisting an
 * AutoFlow event/settings mutation. The UUID identifies this operation only;
 * no payload, credential, or error text is ever put in the outbox.
 */
export async function reserveAutoflowDashboardUpdate(
  db: Db,
  shopId: string | number,
  source: AutoflowDashboardUpdateSource,
): Promise<string> {
  const normalizedShopId = normalizeShopId(shopId);
  validateSource(source);
  await initializeIndexes(db);

  const now = __deps.now();
  const id = randomUUID();
  const intent: OutboxIntent = {
    _id: id,
    shopId: normalizedShopId,
    source,
    status: "prepared",
    finalized: false,
    attempts: 0,
    createdAt: new Date(now),
    dueAt: new Date(now + PREPARED_GRACE_MS),
  };
  await db
    .collection<OutboxIntent>(COLLECTION)
    .insertOne(intent, BOUNDED_DB_OPTIONS);
  return id;
}

async function claimById(db: Db, id: string): Promise<OutboxIntent | null> {
  const now = __deps.now();
  const token = randomUUID();
  const result = await db.collection<OutboxIntent>(COLLECTION).findOneAndUpdate(
    {
      _id: id,
      status: { $in: ["prepared", "ready"] },
      attempts: { $lt: MAX_ATTEMPTS },
      createdAt: { $gt: new Date(now - INTENT_LIFETIME_MS) },
      dueAt: { $lte: new Date(now) },
      $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: new Date(now) } }],
    },
    {
      $inc: { attempts: 1 },
      $set: {
        leaseToken: token,
        leaseUntil: new Date(now + LEASE_MS),
      },
    },
    {
      returnDocument: "after",
      includeResultMetadata: false,
      ...BOUNDED_DB_OPTIONS,
    },
  );
  return unwrapFindOneAndUpdate(result as any);
}

async function acknowledgeDelivery(
  db: Db,
  intent: OutboxIntent,
  delivered: boolean,
): Promise<void> {
  const collection = db.collection<OutboxIntent>(COLLECTION);
  const fence = { _id: intent._id, leaseToken: intent.leaseToken };

  if (delivered && intent.status === "ready") {
    await collection.deleteOne(fence, BOUNDED_DB_OPTIONS);
    return;
  }

  if (intent.attempts >= MAX_ATTEMPTS) {
    const result = await collection.updateOne(
      fence,
      {
        $set: { status: "terminal", terminalAt: new Date(__deps.now()) },
        $unset: { leaseToken: "", leaseUntil: "" },
      },
      BOUNDED_DB_OPTIONS,
    );
    if (result.modifiedCount > 0) {
      console.error("[autoflow-dashboard-outbox] delivery exhausted", {
        id: intent._id,
        shopId: intent.shopId,
        source: intent.source,
      });
    }
    return;
  }

  await collection.updateOne(
    fence,
    {
      $set: { dueAt: new Date(__deps.now() + backoffMs(intent.attempts)) },
      $unset: { leaseToken: "", leaseUntil: "" },
    },
    BOUNDED_DB_OPTIONS,
  );
}

async function deliverClaim(db: Db, intent: OutboxIntent): Promise<void> {
  let delivered = false;
  try {
    await __deps.bumpDashboardUpdate(
      db,
      intent.source,
      intent.shopId,
      // Bound server execution AND client-side waiting (MongoDB CSOT).
      BOUNDED_DB_OPTIONS,
    );
    delivered = true;
  } catch {
    // Delivery errors are intentionally not persisted (they may contain PII).
  }

  try {
    await acknowledgeDelivery(db, intent, delivered);
  } catch {
    // A missing acknowledgement causes an at-least-once duplicate after lease
    // expiry; it can never cause the upstream business operation to be replayed.
  }
}

/**
 * Finalize after either definite business success or an uncertain business
 * outcome. Conservative invalidation is safe; replaying upstream work is not.
 *
 * Finalization is a one-way CAS. It resets attempts exactly once, so repeated
 * late calls cannot provide an exhausted ready intent with unlimited retries.
 * Temporary I/O never escapes this API: a failed ready-state write leaves the
 * prepared intent durable and recoverable after its grace period.
 */
export async function finishAutoflowDashboardUpdate(db: Db, id: string): Promise<void> {
  if (
    typeof id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
  ) {
    throw new TypeError("id must be an operation UUID");
  }
  try {
    await initializeIndexes(db);
    const now = __deps.now();
    await db.collection<OutboxIntent>(COLLECTION).updateOne(
      { _id: id, finalized: false },
      {
        $set: {
          finalized: true,
          status: "ready",
          attempts: 0,
          dueAt: new Date(now),
          finalizedAt: new Date(now),
        },
        $unset: { leaseToken: "", leaseUntil: "", terminalAt: "" },
      },
      BOUNDED_DB_OPTIONS,
    );

    // Claim after the ready marker is durable. If a cron worker won the claim,
    // it owns delivery; otherwise this fast path provides immediate invalidation.
    const intent = await claimById(db, id);
    if (intent) await deliverClaim(db, intent);
  } catch {
    // Never turn a completed/uncertain upstream write into an HTTP retry. If
    // finalization failed, the prepared write-ahead intent remains recoverable.
    console.error("[autoflow-dashboard-outbox] finish deferred", { id });
  }
}

async function terminalizeOne(db: Db): Promise<OutboxIntent | null> {
  const now = __deps.now();
  const result = await db.collection<OutboxIntent>(COLLECTION).findOneAndUpdate(
    {
      status: { $in: ["prepared", "ready"] },
      $and: [
        {
          $or: [
            { leaseUntil: { $exists: false } },
            { leaseUntil: { $lte: new Date(now) } },
          ],
        },
        {
          $or: [
            { attempts: { $gte: MAX_ATTEMPTS } },
            { createdAt: { $lte: new Date(now - INTENT_LIFETIME_MS) } },
          ],
        },
      ],
    },
    {
      $set: { status: "terminal", terminalAt: new Date(now) },
      $unset: { leaseToken: "", leaseUntil: "" },
    },
    {
      sort: { createdAt: 1 },
      returnDocument: "after",
      includeResultMetadata: false,
      ...BOUNDED_DB_OPTIONS,
    },
  );
  return unwrapFindOneAndUpdate(result as any);
}

async function claimNext(db: Db): Promise<OutboxIntent | null> {
  const now = __deps.now();
  const token = randomUUID();
  const result = await db.collection<OutboxIntent>(COLLECTION).findOneAndUpdate(
    {
      status: { $in: ["prepared", "ready"] },
      attempts: { $lt: MAX_ATTEMPTS },
      createdAt: { $gt: new Date(now - INTENT_LIFETIME_MS) },
      dueAt: { $lte: new Date(now) },
      $or: [{ leaseUntil: { $exists: false } }, { leaseUntil: { $lte: new Date(now) } }],
    },
    {
      $inc: { attempts: 1 },
      $set: { leaseToken: token, leaseUntil: new Date(now + LEASE_MS) },
    },
    {
      sort: { dueAt: 1, createdAt: 1 },
      returnDocument: "after",
      includeResultMetadata: false,
      ...BOUNDED_DB_OPTIONS,
    },
  );
  return unwrapFindOneAndUpdate(result as any);
}

/**
 * Cron drain: bounded to 25 intents and 20 seconds. Every claim is an atomic
 * lease-and-increment with a random fencing token. Consequently a crashed
 * worker consumes an attempt, and a stale worker cannot acknowledge over a
 * newer worker's lease.
 */
export async function drainAutoflowDashboardUpdates(db: Db): Promise<number> {
  const startedAt = __deps.now();
  await initializeIndexes(db);
  let handled = 0;

  // Reserve enough time for terminal lookup, claim, bump, and acknowledgement
  // before starting another item; a deadline check alone can overrun by 8s.
  while (
    handled < MAX_BATCH &&
    __deps.now() - startedAt < DRAIN_BUDGET_MS - 4 * DB_TIMEOUT_MS
  ) {
    const terminal = await terminalizeOne(db);
    if (terminal) {
      handled += 1;
      console.error("[autoflow-dashboard-outbox] delivery exhausted", {
        id: terminal._id,
        shopId: terminal.shopId,
        source: terminal.source,
      });
      continue;
    }

    const intent = await claimNext(db);
    if (!intent) break;
    handled += 1;
    await deliverClaim(db, intent);
  }
  return handled;
}