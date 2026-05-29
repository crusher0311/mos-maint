/**
 * Task #542 smoke test: ZINK cloud print queue.
 *
 * Covers:
 *   - enqueue writes a pending job scoped to a shop
 *   - poll/claim transitions pending -> in-flight (FIFO, atomic)
 *   - ack transitions in-flight -> done / failed with timestamps
 *   - cross-shop isolation: a shop can never claim or ack another's job
 *   - device routing: a printerId-tagged job is only served to a matching agent
 *   - stale in-flight jobs become re-servable (stuck job recovery)
 *   - printer-config defaults layer into outgoing job options
 *   - the cloud module opens NO printer socket (static source guard)
 *
 * Run: `npx tsx tests/print-queue.smoke.ts`
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ObjectId } from "mongodb";

import * as repo from "../lib/print-queue/repository";
import { STALE_INFLIGHT_MS } from "../lib/print-queue/types";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Minimal in-memory Mongo fake — implements only the operators the
// repository uses ($or, $and, $exists, $lt, equality, ObjectId match).
// ---------------------------------------------------------------------------

function matchField(value: any, cond: any): boolean {
  if (cond && typeof cond === "object" && !Array.isArray(cond) && !(cond instanceof Date) && !(cond instanceof ObjectId)) {
    for (const [op, operand] of Object.entries(cond)) {
      if (op === "$exists") {
        if ((value !== undefined) !== operand) return false;
      } else if (op === "$lt") {
        if (!(value != null && value < (operand as any))) return false;
      } else if (op === "$gt") {
        if (!(value != null && value > (operand as any))) return false;
      } else {
        return false;
      }
    }
    return true;
  }
  if (cond instanceof ObjectId) {
    return value instanceof ObjectId ? value.equals(cond) : String(value) === String(cond);
  }
  return value === cond;
}

function matchFilter(doc: any, filter: any): boolean {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === "$or") {
      if (!(cond as any[]).some((f) => matchFilter(doc, f))) return false;
    } else if (key === "$and") {
      if (!(cond as any[]).every((f) => matchFilter(doc, f))) return false;
    } else {
      if (!matchField(doc[key], cond)) return false;
    }
  }
  return true;
}

function applyUpdate(doc: any, update: any) {
  if (update.$set) Object.assign(doc, update.$set);
  if (update.$inc) {
    for (const [k, v] of Object.entries(update.$inc)) {
      doc[k] = (doc[k] ?? 0) + (v as number);
    }
  }
}

class FakeCollection {
  docs: any[] = [];

  async insertOne(doc: any) {
    const _id = doc._id ?? new ObjectId();
    this.docs.push({ ...doc, _id });
    return { insertedId: _id };
  }

  async findOne(filter: any) {
    const d = this.docs.find((x) => matchFilter(x, filter));
    return d ? { ...d } : null;
  }

  private sorted(filter: any, sort?: Record<string, 1 | -1>) {
    let list = this.docs.filter((x) => matchFilter(x, filter));
    if (sort) {
      const [k, dir] = Object.entries(sort)[0];
      list = list.slice().sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (dir as number));
    }
    return list;
  }

  async findOneAndUpdate(filter: any, update: any, opts: any = {}) {
    const list = this.sorted(filter, opts.sort);
    const target = list[0];
    if (!target) return { value: null };
    applyUpdate(target, update);
    return { value: { ...target } };
  }

  async updateOne(filter: any, update: any, opts: any = {}) {
    const target = this.docs.find((x) => matchFilter(x, filter));
    if (!target) {
      if (opts.upsert) {
        const doc: any = { _id: new ObjectId() };
        applyUpdate(doc, update);
        this.docs.push(doc);
        return { matchedCount: 0, modifiedCount: 0, upsertedId: doc._id };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    }
    applyUpdate(target, update);
    return { matchedCount: 1, modifiedCount: 1 };
  }

  async deleteOne(filter: any) {
    const idx = this.docs.findIndex((x) => matchFilter(x, filter));
    if (idx < 0) return { deletedCount: 0 };
    this.docs.splice(idx, 1);
    return { deletedCount: 1 };
  }
}

class FakeDb {
  cols = new Map<string, FakeCollection>();
  collection(name: string) {
    if (!this.cols.has(name)) this.cols.set(name, new FakeCollection());
    return this.cols.get(name)!;
  }
}

async function run() {
  console.log("ZINK print queue (Task #542)");

  const db = new FakeDb();
  (repo.__deps as any).getDb = async () => db;

  const SHOP_A = 101;
  const SHOP_B = 202;

  // --- enqueue + claim FIFO ---
  const j1 = await repo.enqueuePrintJob({ shopId: SHOP_A, imageBase64: "AAAA", kind: "keytag" });
  const j2 = await repo.enqueuePrintJob({ shopId: SHOP_A, imageBase64: "BBBB", kind: "sticker" });
  ok("enqueue returns distinct ids", j1 !== j2 && !!j1 && !!j2);

  const jobsCol = db.collection(repo.__collections.JOBS_COLLECTION);
  ok("enqueued job is pending", jobsCol.docs[0].status === "pending");
  ok("enqueued job scoped to shop", jobsCol.docs[0].shopId === SHOP_A);

  const claim1 = await repo.claimNextJob(SHOP_A);
  ok("claim returns oldest job first (FIFO)", claim1?.id === j1, `got ${claim1?.id}`);
  ok("claim returns image payload", claim1?.imageBase64 === "AAAA");
  const claimedDoc = jobsCol.docs.find((d) => String(d._id) === j1);
  ok("claim transitions pending -> in-flight", claimedDoc.status === "in-flight");
  ok("claim sets claimedAt + increments attempts", !!claimedDoc.claimedAt && claimedDoc.attempts === 1);

  // --- cross-shop isolation on claim ---
  const claimB = await repo.claimNextJob(SHOP_B);
  ok("shop B cannot claim shop A's jobs", claimB === null);

  // --- ack success ---
  const ackRes = await repo.ackJob(SHOP_A, j1, "success", { durationMs: 42, agentVersion: "1.0.0" });
  ok("ack success returns acked", ackRes === "acked");
  ok("ack success -> status done", claimedDoc.status === "done");
  ok("ack success sets completedAt + durationMs", !!claimedDoc.completedAt && claimedDoc.durationMs === 42);

  // --- cross-shop isolation on ack ---
  const claim2 = await repo.claimNextJob(SHOP_A); // claims j2
  ok("second claim returns j2", claim2?.id === j2);
  const ackForeign = await repo.ackJob(SHOP_B, j2, "success");
  ok("shop B cannot ack shop A's job", ackForeign === "not_found");
  const j2Doc = jobsCol.docs.find((d) => String(d._id) === j2);
  ok("foreign ack did not mutate job", j2Doc.status === "in-flight");

  // --- ack failure path ---
  const ackFail = await repo.ackJob(SHOP_A, j2, "failure", { error: "printer offline" });
  ok("ack failure returns acked", ackFail === "acked");
  ok("ack failure -> status failed", j2Doc.status === "failed");
  ok("ack failure records error + failedAt", j2Doc.error === "printer offline" && !!j2Doc.failedAt);

  // --- unknown job id ---
  const ackUnknown = await repo.ackJob(SHOP_A, String(new ObjectId()), "success");
  ok("ack of unknown id -> not_found", ackUnknown === "not_found");
  ok("ack of malformed id -> not_found", (await repo.ackJob(SHOP_A, "not-an-oid", "success")) === "not_found");

  // --- device routing ---
  const tagged = await repo.enqueuePrintJob({ shopId: SHOP_A, imageBase64: "DDDD", printerId: "front-counter" });
  const claimNoPrinter = await repo.claimNextJob(SHOP_A); // no printerId -> must NOT get tagged job
  ok("untagged agent does not claim a printerId-tagged job", claimNoPrinter === null, `got ${claimNoPrinter?.id}`);
  const claimWrongPrinter = await repo.claimNextJob(SHOP_A, "back-office");
  ok("wrong-printer agent does not claim tagged job", claimWrongPrinter === null);
  const claimRightPrinter = await repo.claimNextJob(SHOP_A, "front-counter");
  ok("matching-printer agent claims tagged job", claimRightPrinter?.id === tagged);

  // --- stale in-flight recovery ---
  const stuck = await repo.enqueuePrintJob({ shopId: SHOP_A, imageBase64: "EEEE" });
  const firstClaim = await repo.claimNextJob(SHOP_A);
  ok("stuck job first claimed", firstClaim?.id === stuck);
  const stuckDoc = jobsCol.docs.find((d) => String(d._id) === stuck);
  // age the claim past the stale window
  stuckDoc.claimedAt = new Date(Date.now() - STALE_INFLIGHT_MS - 1000);
  const reclaim = await repo.claimNextJob(SHOP_A);
  ok("stale in-flight job is re-servable", reclaim?.id === stuck);
  ok("reclaim increments attempts", stuckDoc.attempts === 2);

  // --- printer config defaults ---
  const cfg = await repo.upsertPrinterConfig(SHOP_A, { address: "zink.local" });
  ok("config upsert applies hardware defaults", cfg.port === 9100 && cfg.defaultCut === 1 && cfg.defaultSpeed === 0 && cfg.defaultWidth === 640);
  const cfg2 = await repo.upsertPrinterConfig(SHOP_A, { defaultSpeed: 1 });
  ok("config upsert merges (keeps address, updates speed)", cfg2.address === "zink.local" && cfg2.defaultSpeed === 1);
  const readCfg = await repo.getPrinterConfig(SHOP_A);
  ok("config readback matches", readCfg?.address === "zink.local" && readCfg?.defaultSpeed === 1);
  ok("config is shop-scoped (shop B has none)", (await repo.getPrinterConfig(SHOP_B)) === null);

  const opts = repo.resolveJobOptions(readCfg, { cut: 0 });
  ok("resolveJobOptions: override beats default", opts.cut === 0);
  ok("resolveJobOptions: default fills the rest", opts.speed === 1 && opts.width === 640);
  const optsNoCfg = repo.resolveJobOptions(null);
  ok("resolveJobOptions: hardware defaults with no config", optsNoCfg.cut === 1 && optsNoCfg.speed === 0 && optsNoCfg.width === 640);

  // --- admin: re-queue a failed job (Milestone 3) ---
  const reqJob = await repo.enqueuePrintJob({ shopId: SHOP_A, imageBase64: "RRRR" });
  await repo.claimNextJob(SHOP_A); // -> in-flight
  await repo.ackJob(SHOP_A, reqJob, "failure", { error: "offline" });
  const reqDoc = jobsCol.docs.find((d) => String(d._id) === reqJob);
  ok("job is failed before requeue", reqDoc.status === "failed");
  const requeued = await repo.requeueJob(SHOP_A, reqJob);
  ok("requeue returns requeued", requeued === "requeued");
  ok("requeue resets to pending + clears error/attempts", reqDoc.status === "pending" && reqDoc.error === null && reqDoc.attempts === 0);
  ok("requeue clears terminal timestamps", reqDoc.failedAt === null && reqDoc.completedAt === null && reqDoc.claimedAt === null);
  ok("requeued job is re-claimable", (await repo.claimNextJob(SHOP_A))?.id === reqJob);

  // --- admin: cross-shop isolation on requeue/clear ---
  ok("shop B cannot requeue shop A's job", (await repo.requeueJob(SHOP_B, reqJob)) === "not_found");
  ok("requeue of malformed id -> not_found", (await repo.requeueJob(SHOP_A, "nope")) === "not_found");

  // --- admin: clear a job (Milestone 3) ---
  const clrJob = await repo.enqueuePrintJob({ shopId: SHOP_A, imageBase64: "CCCC" });
  ok("shop B cannot clear shop A's job", (await repo.clearJob(SHOP_B, clrJob)) === "not_found");
  const cleared = await repo.clearJob(SHOP_A, clrJob);
  ok("clear returns cleared", cleared === "cleared");
  ok("cleared job is gone", !jobsCol.docs.some((d) => String(d._id) === clrJob));
  ok("clear of unknown id -> not_found", (await repo.clearJob(SHOP_A, String(new ObjectId()))) === "not_found");

  // --- agent heartbeat recording (Milestone 3) ---
  const hbCol = db.collection(repo.__collections.HEARTBEAT_COLLECTION);
  await repo.recordAgentPoll(SHOP_A, null, "1.2.3");
  ok("heartbeat upserts a row", hbCol.docs.length === 1);
  ok("null printerId collapses to default bucket", hbCol.docs[0].printerId === "default");
  ok("heartbeat records lastPollAt + version", !!hbCol.docs[0].lastPollAt && hbCol.docs[0].agentVersion === "1.2.3");
  const firstPoll = hbCol.docs[0].lastPollAt;
  await new Promise((r) => setTimeout(r, 5));
  await repo.recordAgentPoll(SHOP_A, null);
  ok("re-poll updates same row (no duplicate)", hbCol.docs.length === 1);
  ok("re-poll advances lastPollAt", hbCol.docs[0].lastPollAt > firstPoll);
  await repo.recordAgentPoll(SHOP_A, "front-counter");
  ok("distinct printerId gets its own heartbeat row", hbCol.docs.length === 2);

  // --- no printer socket opened server-side (static guard) ---
  const SRC_DIR = path.resolve(__dirname, "..", "lib", "print-queue");
  const ROUTE_DIRS = [
    path.resolve(__dirname, "..", "app", "api", "print-agent"),
    path.resolve(__dirname, "..", "app", "api", "extension", "print"),
  ];
  function collect(dir: string, acc: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) collect(full, acc);
      else if (e.name.endsWith(".ts")) acc.push(full);
    }
    return acc;
  }
  const files = [collect(SRC_DIR), ...ROUTE_DIRS.map((d) => collect(d))].flat();
  const SOCKET_RE = /\b(require\(["']net["']\)|require\(["']tls["']\)|from\s+["']net["']|from\s+["']tls["']|createConnection|\.connect\s*\(|:9100)\b/;
  const offenders = files.filter((f) => SOCKET_RE.test(fs.readFileSync(f, "utf8")));
  ok("no print-queue file opens a printer socket", offenders.length === 0, offenders.join(", "));

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll print-queue smoke cases passed.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
