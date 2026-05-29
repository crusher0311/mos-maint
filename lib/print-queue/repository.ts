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
  PRINTER_DEFAULTS,
  STALE_INFLIGHT_MS,
  type AgentPrintJob,
  type JobOutcome,
  type PrintJobDoc,
  type PrinterConfigDoc,
  type ZinkPrintOptions,
} from "./types";

const JOBS_COLLECTION = "print_jobs";
const CONFIG_COLLECTION = "print_printer_configs";

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
  printer?: PrintJobDoc["printer"];
  kind?: PrintJobDoc["kind"];
  meta?: Record<string, unknown>;
}

/** Write a new pending job. Returns the new job id as a string. */
export async function enqueuePrintJob(input: EnqueueInput): Promise<string> {
  const now = new Date();
  const doc: PrintJobDoc = {
    shopId: input.shopId,
    status: "pending",
    imageBase64: input.imageBase64,
    printerId: input.printerId ?? null,
    printer: input.printer,
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

  const job: AgentPrintJob = {
    id: String(doc._id),
    imageBase64: doc.imageBase64,
  };
  if (doc.printer) job.printer = doc.printer;
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

/** Test seam — exposes collection names so smoke tests can assert scoping. */
export const __collections = {
  JOBS_COLLECTION,
  CONFIG_COLLECTION,
};
