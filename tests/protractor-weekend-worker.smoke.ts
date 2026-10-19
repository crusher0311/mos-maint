import "./helpers/deny-network-egress";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { WEEKEND } from "../lib/protractor-weekend-policy";
import { pilotInvoiceIds } from "../lib/protractor-afton-pilot-report";
import * as historyLookup from "../lib/protractor-history-existing-invoice";
import * as heldFailure from "../lib/protractor-held-failure";

const compiled = ts.transpileModule(readFileSync("scripts/protractor-weekend/ingest.ts", "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const ID = "11111111-1111-4111-8111-111111111111";
async function scenario(options: {
  existing?: boolean; indexed?: boolean; receipt?: string; priorReceipt?: string;
  thin?: boolean; partial?: boolean; active?: boolean; corrupt?: boolean;
  failAt?: string;
  realIPC?: boolean;
  yieldAfterFirst?: boolean;
  resume?: boolean;
  checkpointFailure?: boolean;
} = {}) {
  let time = Date.now();
  class Clock extends Date { static now() { return time; } }
  const page: any = { _id: `${WEEKEND.id}:457:2026-10-16:0`, campaignId: WEEKEND.id,
    shopId: 457, day: "2026-10-16", invoices: [{ ID, Total: 20 }] };
  page.digest = options.corrupt ? "bad" : hash(page.invoices);
  if (options.yieldAfterFirst) {
    page.invoices.push({ ID: "22222222-2222-4222-8222-222222222222", Total: 20 });
    page.digest = hash(page.invoices);
  }
  const receipts = new Map<string, any>();
  const receiptId = `${WEEKEND.id}:457:${hash(ID)}`;
  if (options.receipt) receipts.set(receiptId, { status: options.receipt });
  let writes = 0;
  const messages: any[] = [];
  const fail = (stage: string) => {
    if (options.failAt === stage) throw Object.assign(Error("private SQL and credentials"), { code: "57014" });
  };
  const stores = {
    pages: { findOne: async () => page, updateOne: async (_: any, u: any) => {
      if (options.checkpointFailure && u.$set.resume) return { matchedCount: 0 };
      Object.assign(page, u.$set); return { matchedCount: 1 };
    } },
    receipts: {
      findOne: async (q: any) => q._id.startsWith("prior:")
        ? options.priorReceipt ? { status: options.priorReceipt } : null : receipts.get(q._id),
      insertOne: async (row: any) => { assert.ok(!receipts.has(row._id)); receipts.set(row._id, row); },
      updateOne: async (q: any, u: any) => {
        fail("receipt_completion");
        return Object.assign(receipts.get(q._id), u.$set);
      },
    },
    jobs: { updateOne: async () => ({ matchedCount: 1 }) },
    db: { collection: (name: string) => ({ findOne: async () => {
      fail(name === "normalized_work_orders" ? "mongo_duplicate_check" : "ingestion_verification");
      return name === "normalized_work_orders" ? options.existing ? { _id: "existing" } : null
        : options.indexed === false ? null : { _id: "indexed" };
    } }) },
  };
  const fakeRequire = (name: string): any => {
    if (name.endsWith("/protractor-history-existing-invoice")) return historyLookup;
    if (name.endsWith("/protractor-held-failure")) return heldFailure;
    if (name === "node:assert/strict") return assert;
    if (name.endsWith("/drizzle")) return { getClient: () => ({
      begin: async (fn: any) => {
        fail("postgres_duplicate_check");
        return fn({ unsafe: async () => [] });
      },
    }) };
    if (name.endsWith("/normalized-ingestion")) return { createIngestionService: () => ({
      ingestWorkOrderWithAllEntities: async () => {
        writes++; if (options.yieldAfterFirst) time += 60000;
        fail("ingestion"); return { workOrder: { success: true },
          serviceJobs: [{ success: !options.partial }], lineItems: [], payments: [], inspections: [], recommendations: [] };
      },
    }) };
    if (name.endsWith("/job-index")) return { extractJobIndexFromWorkOrder: () => options.thin ? [] : [{}] };
    if (name.endsWith("/protractor-weekend-policy")) return { WEEKEND };
    if (name.endsWith("/protractor-afton-pilot-report")) return { pilotInvoiceIds };
    if (name === "./shared") return {
      runtime: () => {}, hash, sleep: async () => {}, collections: async () => stores,
      assertOwner: async () => {
        if (options.active) throw Error("Live traffic takes priority");
        return { job: { shops: [{ shopId: 457, priorJobId: "prior" }] } };
      },
    };
    throw Error(`Unexpected dependency ${name}`);
  };
  const exports: any = {};
  vm.runInNewContext(compiled, { require: fakeRequire, exports, process: options.realIPC ? process : {
    send: (message: any, callback: () => void) => { messages.push(message); callback(); }, exit: process.exit,
  },
    setTimeout, clearTimeout, console, Date: Clock });
  let error: unknown;
  try { await exports.ingestPage(page._id, "owner"); } catch (e) { error = e; }
  if (options.yieldAfterFirst && !error) {
    assert.equal(writes, 1);
    assert.equal(page.checked, undefined);
    assert.equal(page.resume.next, 1);
    assert.equal(receipts.size, 1, "No second write may start before yielding");
    if (options.resume) await exports.ingestPage(page._id, "owner");
  }
  return { page, writes, receipt: receipts.get(receiptId), error, messages };
}
async function main() {
  const yielded = await scenario({ yieldAfterFirst: true });
  assert.equal(yielded.error, undefined);
  assert.equal(yielded.messages[0].event, "weekend_ingest_yielded");
  const resumed = await scenario({ yieldAfterFirst: true, resume: true });
  assert.equal(resumed.writes, 2, "Resume must not re-ingest the first invoice");
  assert.equal(resumed.page.checked, true);
  assert.equal(resumed.page.unresolved, 0);
  const partialResume = await scenario({ yieldAfterFirst: true, resume: true, partial: true });
  assert.equal(partialResume.writes, 2);
  assert.equal(partialResume.page.unresolved, 2);
  assert.equal(partialResume.page.imported, false, "Resume must retain ambiguous writes");
  const lostCheckpoint = await scenario({ yieldAfterFirst: true, checkpointFailure: true });
  assert.ok(lostCheckpoint.error);
  assert.ok(!lostCheckpoint.messages.some(m => m.event === "weekend_ingest_yielded"));
  let result = await scenario();
  assert.equal(result.writes, 1); assert.equal(result.receipt.status, "imported"); assert.equal(result.page.imported, true);
  result = await scenario({ partial: true });
  assert.equal(result.receipt.status, "processing"); assert.equal(result.page.imported, false);
  result = await scenario({ receipt: "processing" });
  assert.equal(result.writes, 0); assert.equal(result.page.unresolved, 1);
  result = await scenario({ priorReceipt: "processing" });
  assert.equal(result.writes, 0); assert.equal(result.receipt.status, "prior-ambiguous");
  result = await scenario({ existing: true });
  assert.equal(result.writes, 0); assert.equal(result.receipt.status, "present");
  result = await scenario({ existing: true, indexed: false });
  assert.equal(result.writes, 0); assert.equal(result.receipt.status, "existing-needs-index-review");
  result = await scenario({ thin: true });
  assert.equal(result.writes, 0); assert.equal(result.receipt.status, "thin");
  result = await scenario({ active: true });
  assert.ok(result.error); assert.equal(result.writes, 0);
  result = await scenario({ corrupt: true });
  assert.ok(result.error); assert.equal(result.writes, 0);
  result = await scenario({ receipt: "imported" });
  assert.equal(result.writes, 0); assert.equal(result.page.imported, true);
  for (const stage of ["mongo_duplicate_check", "postgres_duplicate_check", "ingestion",
    "ingestion_verification", "receipt_completion"]) {
    result = await scenario({ failAt: stage });
    assert.ok(result.error);
    assert.deepEqual(JSON.parse(JSON.stringify(result.messages)), [
      { event: "weekend_ingest_failed", stage, code: "57014" },
    ]);
    assert.equal(result.page.checked, undefined);
    if (stage.endsWith("duplicate_check")) {
      assert.equal(result.writes, 0);
      assert.equal(result.receipt, undefined);
    } else {
      assert.equal(result.writes, 1);
      assert.equal(result.receipt.status, "processing");
    }
  }
  console.log("PASS: weekend ingestion, preserved receipts, partial writes, existing invoices, thin data and live-activity stop");
}
if (process.argv[2] === "--ipc-yield") {
  scenario({ yieldAfterFirst: true, realIPC: true }).then(result => {
    assert.equal(result.error, undefined); process.exit(0);
  }).catch(() => process.exit(1));
} else if (process.argv[2] === "--ipc-failure") {
  scenario({ failAt: process.argv[3], realIPC: true }).then(result => {
    assert.ok(result.error);
    process.exit(1);
  });
} else {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
