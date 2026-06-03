/**
 * Static guard for three load-bearing queue invariants that have no
 * other test coverage and each silently broke the dormant-queue canary
 * rollout:
 *
 *   1. BullMQ forbids ":" in a custom jobId (it throws "Custom Ids
 *      cannot contain :"). A colon delimiter made every enqueue fail,
 *      get caught as `queue_unavailable`, and fall back to the
 *      in-process path — so the queue never received a single job. All
 *      producer jobIds must use "_" as the field delimiter.
 *
 *   2. These jobs use a STABLE per-shop jobId and are re-driven
 *      chunk-by-chunk by the cron. `DEFAULT_JOB_OPTS.removeOnComplete`
 *      MUST be `true`: a lingering completed job dedupe-blocks the next
 *      chunk's enqueue. `removeOnFail` must stay falsey so failures are
 *      preserved for retry/inspection.
 *
 *   3. `runFullPageBackfillChunk` dereferences `db.collection(...)`
 *      immediately, so the full-page processor must resolve a live Mongo
 *      handle (getDb()) and pass it in — never `null`.
 *
 * Runs with NO Redis (pure import + source assertions), so it is safe in
 * the prebuild smoke chain where it would have caught all three bugs
 * before they shipped.
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";

import { DEFAULT_JOB_OPTS } from "../lib/queue/queues";

function readSrc(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), "utf8");
}

function main() {
  // (1) No producer jobId may contain ":".
  const producer = readSrc("lib/queue/producer.ts");
  for (const m of producer.matchAll(/const\s+jobId\s*=\s*(`[^`]*`)/g)) {
    const literal = m[1];
    assert.ok(
      !literal.includes(":"),
      `producer jobId template must not contain ":" (BullMQ forbids it): ${literal}`,
    );
  }

  // (2) DEFAULT_JOB_OPTS must remove on complete, keep failures.
  assert.strictEqual(
    (DEFAULT_JOB_OPTS as any).removeOnComplete,
    true,
    "DEFAULT_JOB_OPTS.removeOnComplete must be true so a completed stable-jobId chunk does not dedupe-block the next enqueue",
  );
  assert.ok(
    !(DEFAULT_JOB_OPTS as any).removeOnFail,
    "DEFAULT_JOB_OPTS.removeOnFail must stay falsey so failed jobs are preserved for retry/inspection",
  );

  // (3) Full-page processor must pass a real db (getDb), never null.
  const fullpage = readSrc("workers/processors/tekmetric-fullpage.ts");
  assert.ok(
    /getDb\s*\(/.test(fullpage),
    "full-page processor must resolve a Mongo handle via getDb()",
  );
  assert.ok(
    !/runFullPageBackfillChunk\(\s*null/.test(fullpage),
    "full-page processor must not pass null as the db arg to runFullPageBackfillChunk (the chunker dereferences db.collection immediately)",
  );

  console.log("queue-jobid-and-opts.smoke.ts: OK");
}

main();
