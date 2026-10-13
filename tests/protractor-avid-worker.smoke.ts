import "./helpers/deny-network-egress";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { AVID_HISTORY as P } from "../lib/protractor-avid-history-policy";

const compiled = ts.transpileModule(readFileSync("scripts/avid-history-worker.ts", "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
const pageId = `${P.jobId}:2026-10-13:0`;
function fixture() {
  const invoices = ids.map(ID => ({ ID, Total: 10 }));
  return {
    page: { _id: pageId, shopId: 457, day: "2026-10-13", invoices, digest: hash(invoices) } as any,
    receipts: new Map<string, any>(), calls: [] as string[], stopped: false,
  };
}
async function run(f: ReturnType<typeof fixture>, behavior: "ok" | "hang" | "partial" | "thin" = "ok") {
  return new Promise<number>((resolve, reject) => {
    const collection = (name: string) => ({
      findOne: async (q: any) => {
        if (name === "operator_history_import_pages") return f.page;
        if (name === "operator_history_import_receipts") return f.receipts.get(q._id);
        if (name === "operator_history_import_jobs") return f.stopped ? null : { runId: "run" };
        return { operatorStop: { active: f.stopped }, avidHistory: { runId: "run", stopped: false,
          canaryGeneration: "gen" }, canary: { generation: "gen" } };
      },
      updateOne: async (q: any, u: any) => {
        if (name === "operator_history_import_pages") Object.assign(f.page, u.$set);
        else f.receipts.set(q._id, { ...f.receipts.get(q._id), ...u.$set });
        return { modifiedCount: 1 };
      },
    });
    const requireMock = (name: string): any => {
      if (name === "node:assert/strict") return assert;
      if (name === "node:crypto") return { createHash };
      if (name.endsWith("/mongo")) return { getDb: async () => ({ collection }) };
      if (name.endsWith("protractor-avid-history-policy")) return { AVID_HISTORY: P };
      if (name.endsWith("/job-index")) return { extractJobIndexFromWorkOrder: () => behavior === "thin" ? [] : [{}] };
      if (name.endsWith("/normalized-ingestion")) return { createIngestionService: () => ({
        ingestWorkOrderWithAllEntities: async (invoice: any) => {
          f.calls.push(invoice.ID);
          if (behavior === "hang") return new Promise(() => {});
          return { workOrder: { success: true }, serviceJobs: [{ success: behavior !== "partial" }],
            lineItems: [], payments: [], inspections: [], recommendations: [] };
        },
      }) };
      throw Error("Unexpected dependency " + name);
    };
    class Clock extends Date { static now() { return Date.parse("2026-10-13T22:01:00Z"); } }
    try {
      vm.runInNewContext(compiled, {
        exports: {}, require: requireMock, Date: Clock,
        process: { env: { RENDER: "true", NORMALIZED_INGEST_WRITE_CONCURRENCY: "1" },
          argv: ["node", "worker", pageId, "owner"], exit: (code: number) => resolve(code) },
        console: { error() {} }, setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms === 120000 ? 20 : 0),
        clearTimeout,
      });
    } catch (e) { reject(e); }
  });
}
async function main() {
  let f = fixture(); assert.equal(await run(f), 0); assert.equal(f.page.imported, true);
  assert.equal(f.receipts.size, 2); assert.ok([...f.receipts.values()].every(r => r.status === "imported"));
  await run(f); assert.equal(f.calls.length, 2, "confirmed invoices never reimported");
  f = fixture(); assert.equal(await run(f, "hang"), 75);
  assert.equal(f.receipts.get(`${P.jobId}:${hash(ids[0])}`).status, "processing");
  assert.notEqual(f.page.imported, true);
  assert.equal(await run(f), 0);
  assert.deepEqual(f.calls, ids, "restart skips ambiguous first write and imports unrelated second invoice");
  assert.equal(f.page.imported, false); assert.equal(f.page.pending, 1);
  f = fixture(); await run(f, "partial"); assert.equal(f.page.imported, false);
  assert.ok([...f.receipts.values()].every(r => r.status === "processing"));
  f = fixture(); await run(f, "thin"); assert.equal(f.calls.length, 0); assert.equal(f.page.imported, false);
  f = fixture(); f.stopped = true; assert.equal(await run(f), 75); assert.equal(f.calls.length, 0);
  f = fixture(); f.page.digest = "corrupted"; assert.equal(await run(f), 75); assert.equal(f.calls.length, 0);
  console.log("Avid worker: completed receipts, no duplicate replay, hung-invoice isolation, partial writes, thin rows, stop and digest checks passed");
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
