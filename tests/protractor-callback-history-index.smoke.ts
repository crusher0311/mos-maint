import assert from "node:assert/strict";
import Module from "node:module";

// Offline only: fail closed on unexpected dependencies and use fake index rows.
const originalLoad = (Module as any)._load;
let entries: any[] = [];
(Module as any)._load = function (request: string, parent: any, isMain: boolean) {
  if (request === "@/lib/job-index") return {
    extractJobIndexFromWorkOrder: () => entries,
    computeJobHash: (entry: any) => `hash-${entry.servicePackageId}`,
  };
  return originalLoad.call(this, request, parent, isMain);
};

async function main() {
  const { indexCallbackHistory } = await import("../lib/integrations/protractor/callback-history-index");
  const reads: any[] = [];
  const writes: any[] = [];
  let existingHash: string | undefined;
  let failWrite = false;
  let acknowledged = true;
  const db: any = {
    collection(name: string) {
      assert.equal(name, "job_index", "never verify through work-order scans");
      return {
        async findOne(filter: any) {
          assert.equal(filter.shopId, 9);
          assert.equal(filter.workOrderId, "synthetic-order");
          reads.push(filter);
          return existingHash ? { contentHash: existingHash } : null;
        },
        async updateOne(filter: any, update: any, options: any) {
          assert.equal(options.upsert, true);
          if (failWrite) throw new Error("synthetic private provider error");
          writes.push({ filter, update });
          return { acknowledged };
        },
      };
    },
  };
  entries = [{ shopId: 9, workOrderId: "synthetic-order", servicePackageId: "job-a", vin: "private" }];
  assert.deepEqual(await indexCallbackHistory(db, 9, {} as any), {
    category: "applied_indexed", reason: "indexed", indexedJobs: 1, changedJobs: 1,
  });
  assert.equal(writes.length, 1);
  existingHash = "hash-job-a";
  assert.deepEqual(await indexCallbackHistory(db, 9, {} as any), {
    category: "applied_indexed", reason: "indexed", indexedJobs: 1, changedJobs: 0,
  });
  assert.equal(writes.length, 1, "hash-verified unchanged entry needs no write");
  existingHash = undefined;
  failWrite = true;
  const failed = await indexCallbackHistory(db, 9, {} as any);
  assert.deepEqual(failed, {
    category: "failed", reason: "indexing_failed", indexedJobs: 0, changedJobs: 0,
  });
  assert.ok(!JSON.stringify(failed).includes("private"));
  failWrite = false;
  acknowledged = false;
  assert.equal((await indexCallbackHistory(db, 9, {} as any)).category, "failed");
  entries = [];
  assert.deepEqual(await indexCallbackHistory(db, 9, {} as any), {
    category: "terminal_no_history", reason: "no_jobs", indexedJobs: 0, changedJobs: 0,
  });
  assert.ok(reads.length > 0);
  console.log("PASS callback history index: actual writes, unchanged hashes, failure, no jobs, bounded keys");
}
main().catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => { (Module as any)._load = originalLoad; });