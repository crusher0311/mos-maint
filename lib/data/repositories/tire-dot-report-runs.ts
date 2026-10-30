import { createHash, randomUUID } from "node:crypto";
import { getDb } from "@/lib/data/db";
import type { TireDotDefinition, TireDotResult, TireDotScope } from "@/lib/tire-dot-report-contract";
import type { TirePilotSelection } from "@/lib/tire-dot-pilot";

export interface TireDotRun {
  _id: string;
  requestKey?: string;
  activeKey?: string;
  requestedBy: string;
  definition: TireDotDefinition;
  scope: TireDotScope;
  sourceMode: "pg" | "mongo" | "pilot";
  pilot?: TirePilotSelection;
  status: "queued" | "running" | "succeeded" | "failed";
  stage: string;
  queuedAt: Date;
  heartbeatAt: Date;
  lease?: string;
  error?: string;
  shopIndex: number;
  cursor: string | null;
  partial: TireDotResult;
  result?: TireDotResult;
}
const collection = async () => (await getDb()).collection<TireDotRun>("tire_dot_report_runs");
export async function createTireRun(input: Omit<TireDotRun, "_id" | "status" | "stage" | "queuedAt" | "heartbeatAt" | "shopIndex" | "cursor">, force = false) {
  const now = new Date();
  const runs = await collection();
  const requestKey = createHash("sha256").update(JSON.stringify({
    version: input.definition.version, requester: input.requestedBy, definition: input.definition,
    scope: input.scope, sourceMode: input.sourceMode, pilotGeneration: input.pilot?.generation,
  })).digest("hex");
  const active = await runs.findOne({ activeKey: requestKey });
  if (active) return active;
  if (!force) {
    const fresh = await runs.findOne({ requestKey, status: "succeeded", heartbeatAt: { $gte: new Date(now.getTime() - 15 * 60_000) } }, { sort: { heartbeatAt: -1 } });
    if (fresh) return fresh;
  }
  const run: TireDotRun = { ...input, _id: randomUUID(), requestKey, activeKey: requestKey, status: "queued", stage: "queued", queuedAt: now, heartbeatAt: now, shopIndex: 0, cursor: null };
  try { await runs.insertOne(run); }
  catch (error) {
    if ((error as any)?.code !== 11000) throw error;
    const winner = await runs.findOne({ activeKey: requestKey });
    if (!winner) throw new Error("Report queue contention; retry");
    return winner;
  }
  return run;
}
export async function findTireRun(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) return null;
  return (await collection()).findOne({ _id: id });
}
export async function claimTireRun(pilotOnly = false) {
  const now = new Date();
  return (await collection()).findOneAndUpdate({
    ...(pilotOnly ? { sourceMode: "pilot" as const } : {}),
    $or: [{ status: "queued" }, { status: "running", heartbeatAt: { $lt: new Date(Date.now() - 120_000) } }],
  }, { $set: { status: "running", stage: "extracting stored evidence", heartbeatAt: now, lease: randomUUID() } },
  { sort: { queuedAt: 1 }, returnDocument: "after", maxTimeMS: 2_000 });
}
/** Lease fencing makes a crashed/reclaimed page retry atomic and idempotent. */
export async function saveTireRun(run: TireDotRun, done: boolean) {
  const now = new Date();
  if (done) run.partial.generatedAt = now.toISOString();
  const update = {
    shopIndex: run.shopIndex, cursor: run.cursor, partial: run.partial, heartbeatAt: now, queuedAt: now,
    status: done ? "succeeded" as const : "queued" as const,
    stage: done ? (run.partial.limited ? "complete with limit" : "complete") : `scanned ${run.partial.coverage.scanned} retained records`,
    ...(done ? { result: run.partial } : {}),
  };
  return (await collection()).updateOne({ _id: run._id, status: "running", lease: run.lease }, { $set: update, $unset: { lease: "", ...(done ? { activeKey: "" } : {}) } });
}
export async function failTireRun(run: TireDotRun, error: string) {
  await (await collection()).updateOne({ _id: run._id, status: "running", lease: run.lease },
    { $set: { status: "failed", stage: "failed", error, heartbeatAt: new Date() }, $unset: { lease: "", activeKey: "" } });
}
