import "./helpers/deny-network-egress";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { WEEKEND } from "../lib/protractor-weekend-policy";
import { pilotInvoiceIds } from "../lib/protractor-afton-pilot-report";
import * as historyLookup from "../lib/protractor-history-existing-invoice";

const compiled = ts.transpileModule(readFileSync("scripts/protractor-weekend/ingest.ts", "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const ID = "11111111-1111-4111-8111-111111111111";
async function scenario(options: {
  existing?: boolean; indexed?: boolean; receipt?: string; priorReceipt?: string;
  thin?: boolean; partial?: boolean; active?: boolean; corrupt?: boolean;
} = {}) {
  const page: any = { _id: `${WEEKEND.id}:457:2026-10-16:0`, campaignId: WEEKEND.id,
    shopId: 457, day: "2026-10-16", invoices: [{ ID, Total: 20 }] };
  page.digest = options.corrupt ? "bad" : hash(page.invoices);
  const receipts = new Map<string, any>();
  const receiptId = `${WEEKEND.id}:457:${hash(ID)}`;
  if (options.receipt) receipts.set(receiptId, { status: options.receipt });
  let writes = 0;
  const stores = {
    pages: { findOne: async () => page, updateOne: async (_: any, u: any) => Object.assign(page, u.$set) },
    receipts: {
      findOne: async (q: any) => q._id.startsWith("prior:")
        ? options.priorReceipt ? { status: options.priorReceipt } : null : receipts.get(q._id),
      insertOne: async (row: any) => { assert.ok(!receipts.has(row._id)); receipts.set(row._id, row); },
      updateOne: async (q: any, u: any) => Object.assign(receipts.get(q._id), u.$set),
    },
    jobs: { updateOne: async () => ({ matchedCount: 1 }) },
    db: { collection: (name: string) => ({ findOne: async () =>
      name === "normalized_work_orders" ? options.existing ? { _id: "existing" } : null
        : options.indexed === false ? null : { _id: "indexed" } }) },
  };
  const fakeRequire = (name: string): any => {
    if (name.endsWith("/protractor-history-existing-invoice")) return historyLookup;
    if (name === "node:assert/strict") return assert;
    if (name.endsWith("/drizzle")) return { getClient: () => ({
      begin: async (fn: any) => fn({ unsafe: async () => [] }),
    }) };
    if (name.endsWith("/normalized-ingestion")) return { createIngestionService: () => ({
      ingestWorkOrderWithAllEntities: async () => {
        writes++; return { workOrder: { success: true },
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
  vm.runInNewContext(compiled, { require: fakeRequire, exports, process,
    setTimeout, clearTimeout, console });
  let error: unknown;
  try { await exports.ingestPage(page._id, "owner"); } catch (e) { error = e; }
  return { page, writes, receipt: receipts.get(receiptId), error };
}
async function main() {
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
  console.log("PASS: weekend ingestion, preserved receipts, partial writes, existing invoices, thin data and live-activity stop");
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
