/**
 * ZINK Cloud Print Queue — MongoDB repository (task #542, Milestone 2).
 *
 * Every function is scoped by `shopId`. There is no code path that reads
 * or claims a job for a different shop than the caller's — that's the
 * cross-shop isolation guarantee the agent endpoints rely on.
 *
 * The cloud opens NO outbound printer sockets; this module only persists
 * and serves jobs. Per-shop printer config lives in a sibling collection.
 */

import type { Collection, Document } from "mongodb";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/mongo";
import {
  MAX_PRINT_IMAGE_BASE64_CHARS,
  PrintPayloadTooLargeError,
  AGENT_ONLINE_THRESHOLD_MS,
  DEFAULT_PRINTER_ID,
  PRINTER_DEFAULTS,
  STALE_INFLIGHT_MS,
  type AgentHeartbeatDoc,
  type AgentPrintJob,
  type JobOutcome,
  type PrintJobDoc,
  type PrinterConfigDoc,
  type ZinkPrintOptions,
} from "./types";

const JOBS_COLLECTION = "print_jobs";
const CONFIG_COLLECTION = "print_printer_configs";
const HEARTBEAT_COLLECTION = "print_agent_heartbeats";

/**
 * Test seam — the smoke suite swaps in an in-memory fake DB without
 * touching real Mongo. Production never assigns to this.
 */
export const __deps: { getDb: typeof getDb } = { getDb };

async function jobsCol(): Promise<Collection<Document>> {
  const db = await __deps.getDb();
  return db.collection<Document>(JOBS_COLLECTION);
}

async function configCol(): Promise<Collection<Document>> {
  const db = await __deps.getDb();
  return db.collection<Document>(CONFIG_COLLECTION);
}

export interface EnqueueInput {
  shopId: number;
  imageBase64: string;
  printerId?: string | null;
  options?: ZinkPrintOptions;
  kind?: PrintJobDoc["kind"];
  meta?: Record<string, unknown>;
}

/** Write a new pending job. Returns the new job id as a string. */
export async function enqueuePrintJob(input: EnqueueInput): Promise<string> {
  if (
    typeof input.imageBase64 !== "string" ||
    input.imageBase64.length > MAX_PRINT_IMAGE_BASE64_CHARS
  ) {
    throw new PrintPayloadTooLargeError("Queued JPEG exceeds the size limit");
  }
  const now = new Date();
  const doc: PrintJobDoc = {
    shopId: input.shopId,
    status: "pending",
    imageBase64: input.imageBase64,
    printerId: input.printerId ?? null,
    options: input.options,
    kind: input.kind,
    meta: input.meta,
    attempts: 0,
    error: null,
    durationMs: null,
    agentVersion: null,
    createdAt: now,
    updatedAt: now,
    claimedAt: null,
    completedAt: null,
    failedAt: null,
  };
  const col = await jobsCol();
  const res = await col.insertOne(doc as Document);
  return String(res.insertedId);
}

/**
 * Atomically claim the next servable job for a shop, transitioning it
 * pending → in-flight. A job is servable when:
 *   - it is pending, OR
 *   - it is in-flight but its claim has gone stale (the previous agent
 *     crashed) — re-serving makes a stuck job visible again.
 *
 * Device routing (forward-compatible with Milestone 3): a job tagged with
 * a `printerId` is only handed to an agent polling with the same
 * `printerId`. Jobs with no `printerId` are claimable by any agent.
 *
 * Returns the agent-facing shape, or null when the queue is empty.
 */
export async function claimNextJob(
  shopId: number,
  printerId?: string | null,
): Promise<AgentPrintJob | null> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_INFLIGHT_MS);

  // Device-routing match: untagged jobs are always claimable; tagged jobs
  // require an agent polling with the same printerId.
  const routeMatch: Document = printerId
    ? { $or: [{ printerId: null }, { printerId: { $exists: false } }, { printerId }] }
    : { $or: [{ printerId: null }, { printerId: { $exists: false } }] };

  const filter: Document = {
    shopId,
    ...routeMatch,
    $and: [
      {
        $or: [
          { status: "pending" },
          { status: "in-flight", claimedAt: { $lt: staleBefore } },
        ],
      },
    ],
  };

  const col = await jobsCol();
  const res = await col.findOneAndUpdate(
    filter,
    {
      $set: { status: "in-flight", claimedAt: now, updatedAt: now },
      $inc: { attempts: 1 },
    },
    { sort: { createdAt: 1 }, returnDocument: "after" },
  );

  const doc = (res && (res as any).value !== undefined ? (res as any).value : res) as
    | PrintJobDoc
    | null;
  if (!doc) return null;

  if (
    typeof doc.imageBase64 !== "string" ||
    doc.imageBase64.length > MAX_PRINT_IMAGE_BASE64_CHARS
  ) {
    await col.updateOne(
      { _id: doc._id, shopId, status: "in-flight" },
      {
        $set: {
          status: "failed",
          error: "Queued JPEG exceeds the size limit; re-render and requeue it",
          failedAt: now,
          updatedAt: now,
        },
      },
    );
    return null;
  }

  const job: AgentPrintJob = {
    id: String(doc._id),
    imageBase64: doc.imageBase64,
  };
  if (doc.options) job.options = doc.options;
  return job;
}

/**
 * Record the terminal outcome of a job. Scoped by shopId so one shop's
 * agent can never ack another shop's job.
 *
 * Returns:
 *   - "acked"     — job existed for this shop and was transitioned (or was
 *                   already terminal — idempotent).
 *   - "not_found" — no job with that id belongs to this shop.
 */
export async function ackJob(
  shopId: number,
  jobId: string,
  outcome: JobOutcome,
  extra?: { error?: string; durationMs?: number; agentVersion?: string },
): Promise<"acked" | "not_found"> {
  let oid: ObjectId;
  try {
    oid = new ObjectId(jobId);
  } catch {
    return "not_found";
  }

  const now = new Date();
  const isSuccess = outcome === "success";
  const set: Document = {
    status: isSuccess ? "done" : "failed",
    updatedAt: now,
    error: isSuccess ? null : extra?.error ?? "agent reported failure",
    durationMs: extra?.durationMs ?? null,
    agentVersion: extra?.agentVersion ?? null,
  };
  if (isSuccess) set.completedAt = now;
  else set.failedAt = now;

  const col = await jobsCol();
  const res = await col.updateOne({ _id: oid, shopId }, { $set: set });
  return res.matchedCount > 0 ? "acked" : "not_found";
}

/** Fetch a single job for a shop (admin/observability use). */
export async function getJob(
  shopId: number,
  jobId: string,
): Promise<PrintJobDoc | null> {
  let oid: ObjectId;
  try {
    oid = new ObjectId(jobId);
  } catch {
    return null;
  }
  const col = await jobsCol();
  return (await col.findOne({ _id: oid, shopId })) as PrintJobDoc | null;
}

// ---------------------------------------------------------------------------
// Per-shop printer config
// ---------------------------------------------------------------------------

export interface PrinterConfigInput {
  address?: string;
  port?: number;
  defaultCut?: 0 | 1;
  defaultSpeed?: 0 | 1;
  defaultWidth?: number;
  printerId?: string | null;
}

function configKey(shopId: number, printerId?: string | null): Document {
  const pid = printerId ?? null;
  return pid === null
    ? { shopId, $or: [{ printerId: null }, { printerId: { $exists: false } }] }
    : { shopId, printerId: pid };
}

/** Read a shop's printer config, or null if none is set. */
export async function getPrinterConfig(
  shopId: number,
  printerId?: string | null,
): Promise<PrinterConfigDoc | null> {
  const col = await configCol();
  return (await col.findOne(configKey(shopId, printerId))) as PrinterConfigDoc | null;
}

/**
 * Create or update a shop's printer config. `address` is required on first
 * write. Returns the resulting config document.
 */
export async function upsertPrinterConfig(
  shopId: number,
  input: PrinterConfigInput,
): Promise<PrinterConfigDoc> {
  const now = new Date();
  const printerId = input.printerId ?? null;
  const col = await configCol();

  const existing = (await col.findOne(
    configKey(shopId, printerId),
  )) as PrinterConfigDoc | null;

  const merged: PrinterConfigDoc = {
    shopId,
    printerId,
    address: input.address ?? existing?.address ?? "",
    port: input.port ?? existing?.port ?? PRINTER_DEFAULTS.port,
    defaultCut: input.defaultCut ?? existing?.defaultCut ?? PRINTER_DEFAULTS.defaultCut,
    defaultSpeed:
      input.defaultSpeed ?? existing?.defaultSpeed ?? PRINTER_DEFAULTS.defaultSpeed,
    defaultWidth:
      input.defaultWidth ?? existing?.defaultWidth ?? PRINTER_DEFAULTS.defaultWidth,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  await col.updateOne(
    configKey(shopId, printerId),
    { $set: merged },
    { upsert: true },
  );

  return merged;
}

/**
 * Build the effective ZINK options for an outgoing job by layering an
 * explicit per-request override on top of the shop's stored defaults
 * (and finally the hardware defaults).
 */
export function resolveJobOptions(
  config: PrinterConfigDoc | null,
  override?: ZinkPrintOptions,
): ZinkPrintOptions {
  return {
    width: override?.width ?? config?.defaultWidth ?? PRINTER_DEFAULTS.defaultWidth,
    cut: override?.cut ?? config?.defaultCut ?? PRINTER_DEFAULTS.defaultCut,
    speed: override?.speed ?? config?.defaultSpeed ?? PRINTER_DEFAULTS.defaultSpeed,
  };
}

// ---------------------------------------------------------------------------
// Agent heartbeats (Milestone 3) — observability only, never gates claiming.
// ---------------------------------------------------------------------------

async function heartbeatCol(): Promise<Collection<Document>> {
  const db = await __deps.getDb();
  return db.collection<Document>(HEARTBEAT_COLLECTION);
}

/**
 * Record that a shop's agent polled. Best-effort observability used by the
 * platform-admin dashboard to show "agent online / last seen". One row per
 * (shopId, printerId); a null/empty printerId collapses to
 * `DEFAULT_PRINTER_ID`.
 */
export async function recordAgentPoll(
  shopId: number,
  printerId?: string | null,
  agentVersion?: string | null,
): Promise<void> {
  const pid = printerId && printerId.trim() !== "" ? printerId.trim() : DEFAULT_PRINTER_ID;
  const now = new Date();
  const set: Document = { shopId, printerId: pid, lastPollAt: now };
  if (agentVersion && agentVersion.trim() !== "") {
    set.agentVersion = agentVersion.trim().slice(0, 64);
  }
  const col = await heartbeatCol();
  await col.updateOne({ shopId, printerId: pid }, { $set: set }, { upsert: true });
}

/**
 * Coarse "is the local agent online" hint derived from the most recent poll
 * heartbeat for a shop (optionally a specific printer). Returns true when the
 * latest heartbeat is within AGENT_ONLINE_THRESHOLD_MS. Best-effort: callers
 * treat any error as offline.
 */
export async function isAgentOnline(
  shopId: number,
  printerId?: string,
): Promise<boolean> {
  const col = await heartbeatCol();
  const filter: Document = { shopId };
  if (printerId && printerId.trim() !== "") filter.printerId = printerId.trim();
  const hb = await col
    .find(filter)
    .sort({ lastPollAt: -1 })
    .limit(1)
    .toArray();
  const last = hb[0]?.lastPollAt;
  if (!last) return false;
  return Date.now() - new Date(last).getTime() < AGENT_ONLINE_THRESHOLD_MS;
}

// ---------------------------------------------------------------------------
// Admin controls (Milestone 3) — every op is shopId-scoped so a foreign id
// can never be mutated cross-shop.
// ---------------------------------------------------------------------------

/**
 * Re-queue a job: reset any non-pending job back to pending so the next
 * polling agent re-claims it. Used by an admin to retry a failed or stuck
 * print. Clears the prior terminal/claim timestamps and error.
 */
export async function requeueJob(
  shopId: number,
  jobId: string,
): Promise<"requeued" | "not_found"> {
  let oid: ObjectId;
  try {
    oid = new ObjectId(jobId);
  } catch {
    return "not_found";
  }
  const now = new Date();
  const col = await jobsCol();
  const res = await col.updateOne(
    { _id: oid, shopId },
    {
      $set: {
        status: "pending",
        updatedAt: now,
        claimedAt: null,
        completedAt: null,
        failedAt: null,
        error: null,
        attempts: 0,
      },
    },
  );
  return res.matchedCount > 0 ? "requeued" : "not_found";
}

/** Permanently remove a job from the queue (admin clear of clutter/stuck). */
export async function clearJob(
  shopId: number,
  jobId: string,
): Promise<"cleared" | "not_found"> {
  let oid: ObjectId;
  try {
    oid = new ObjectId(jobId);
  } catch {
    return "not_found";
  }
  const col = await jobsCol();
  const res = await col.deleteOne({ _id: oid, shopId });
  return res.deletedCount && res.deletedCount > 0 ? "cleared" : "not_found";
}

export interface FleetAgentRow {
  printerId: string;
  lastPollAt: Date;
  agentVersion: string | null;
  online: boolean;
}

export interface FleetJobRow {
  id: string;
  status: PrintJobDoc["status"];
  kind: PrintJobDoc["kind"] | null;
  printerId: string | null;
  attempts: number;
  error: string | null;
  durationMs: number | null;
  createdAt: Date;
  updatedAt: Date | null;
  meta: Record<string, unknown> | null;
}

export interface FleetShopRow {
  shopId: number;
  shopName: string | null;
  configs: PrinterConfigDoc[];
  agents: FleetAgentRow[];
  counts: { pending: number; inFlight: number; done: number; failed: number; total: number };
  recentJobs: FleetJobRow[];
}

/**
 * Build the platform-admin fleet overview: every shop that has any ZINK
 * print footprint (a configured printer, an agent heartbeat, or queued
 * jobs), with its printer config(s), agent online status, job status
 * counts, and a recent-job sample. The image payload is projected OUT — the
 * admin UI never needs (and should never ship) the base64 blob.
 */
export async function getFleetPrintOverview(
  opts?: { recentLimit?: number },
): Promise<FleetShopRow[]> {
  const recentLimit = Math.max(1, Math.min(opts?.recentLimit ?? 15, 50));
  const db = await __deps.getDb();
  const jobs = db.collection<Document>(JOBS_COLLECTION);
  const configs = db.collection<Document>(CONFIG_COLLECTION);
  const heartbeats = db.collection<Document>(HEARTBEAT_COLLECTION);

  const [allConfigs, allHeartbeats, countAgg] = await Promise.all([
    configs.find({}).toArray() as Promise<PrinterConfigDoc[]>,
    heartbeats.find({}).toArray() as Promise<AgentHeartbeatDoc[]>,
    jobs
      .aggregate([
        { $group: { _id: { shopId: "$shopId", status: "$status" }, count: { $sum: 1 } } },
      ])
      .toArray(),
  ]);

  const shopIds = new Set<number>();
  for (const c of allConfigs) if (typeof c.shopId === "number") shopIds.add(c.shopId);
  for (const h of allHeartbeats) if (typeof h.shopId === "number") shopIds.add(h.shopId);
  for (const r of countAgg as any[]) {
    if (typeof r?._id?.shopId === "number") shopIds.add(r._id.shopId);
  }

  const ids = [...shopIds];
  if (ids.length === 0) return [];

  const shopDocs = (await db
    .collection("shops")
    .find({ shopId: { $in: ids } }, { projection: { shopId: 1, name: 1, shopName: 1 } })
    .toArray()) as any[];
  const nameById = new Map<number, string | null>();
  for (const s of shopDocs) {
    nameById.set(s.shopId, s.name ?? s.shopName ?? null);
  }

  // Per-shop counts from the aggregate.
  const countsByShop = new Map<number, FleetShopRow["counts"]>();
  for (const r of countAgg as any[]) {
    const sid = r._id.shopId as number;
    const status = r._id.status as PrintJobDoc["status"];
    const cur =
      countsByShop.get(sid) ?? { pending: 0, inFlight: 0, done: 0, failed: 0, total: 0 };
    if (status === "pending") cur.pending += r.count;
    else if (status === "in-flight") cur.inFlight += r.count;
    else if (status === "done") cur.done += r.count;
    else if (status === "failed") cur.failed += r.count;
    cur.total += r.count;
    countsByShop.set(sid, cur);
  }

  const now = Date.now();
  const heartbeatsByShop = new Map<number, FleetAgentRow[]>();
  for (const h of allHeartbeats) {
    const arr = heartbeatsByShop.get(h.shopId) ?? [];
    arr.push({
      printerId: h.printerId,
      lastPollAt: h.lastPollAt,
      agentVersion: h.agentVersion ?? null,
      online: h.lastPollAt
        ? now - new Date(h.lastPollAt).getTime() < AGENT_ONLINE_THRESHOLD_MS
        : false,
    });
    heartbeatsByShop.set(h.shopId, arr);
  }

  const configsByShop = new Map<number, PrinterConfigDoc[]>();
  for (const c of allConfigs) {
    const arr = configsByShop.get(c.shopId) ?? [];
    arr.push(c);
    configsByShop.set(c.shopId, arr);
  }

  const rows: FleetShopRow[] = await Promise.all(
    ids.map(async (sid) => {
      const recent = (await jobs
        .find({ shopId: sid }, { projection: { imageBase64: 0 } })
        .sort({ createdAt: -1 })
        .limit(recentLimit)
        .toArray()) as PrintJobDoc[];
      const recentJobs: FleetJobRow[] = recent.map((j) => ({
        id: String(j._id),
        status: j.status,
        kind: j.kind ?? null,
        printerId: j.printerId ?? null,
        attempts: j.attempts ?? 0,
        error: j.error ?? null,
        durationMs: j.durationMs ?? null,
        createdAt: j.createdAt,
        updatedAt: j.updatedAt ?? null,
        meta: (j.meta as Record<string, unknown>) ?? null,
      }));
      return {
        shopId: sid,
        shopName: nameById.get(sid) ?? null,
        configs: configsByShop.get(sid) ?? [],
        agents: heartbeatsByShop.get(sid) ?? [],
        counts:
          countsByShop.get(sid) ?? {
            pending: 0,
            inFlight: 0,
            done: 0,
            failed: 0,
            total: 0,
          },
        recentJobs,
      };
    }),
  );

  // Surface shops needing attention first: most failed, then most pending.
  rows.sort((a, b) => {
    if (b.counts.failed !== a.counts.failed) return b.counts.failed - a.counts.failed;
    if (b.counts.pending !== a.counts.pending) return b.counts.pending - a.counts.pending;
    return a.shopId - b.shopId;
  });

  return rows;
}

/** Test seam — exposes collection names so smoke tests can assert scoping. */
export const __collections = {
  JOBS_COLLECTION,
  CONFIG_COLLECTION,
  HEARTBEAT_COLLECTION,
};
