/**
 * BullMQ processor for `drain-protractor` queue (task #513).
 *
 * Mirrors `drain-tekmetric.ts`. The legacy Protractor drain
 * (`scripts/drain-protractor-backfill.ts`) doesn't expose a
 * `backfillShopChunk`-style entry point — it does its own per-shop
 * iteration internally. To keep the scaffold landable without
 * refactoring that script's internals, this processor spawns the
 * existing script as a child process for the duration of the attempt.
 *
 * Follow-up task: factor the Protractor drain into a chunk function
 * and call it in-process the same way the Tekmetric processor does.
 */

import { spawn } from "node:child_process";
import type { Job } from "bullmq";
import type { DrainJobData } from "@/lib/queue/producer";

const DRAIN_ATTEMPT_MAX_MS = 20 * 60 * 1000;

export async function processDrainProtractor(
  job: Job<DrainJobData>,
): Promise<{ exitCode: number | null; complete: boolean }> {
  console.log(
    `[Worker drain-protractor] starting attempt=${job.attemptsMade + 1}`,
  );

  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", "scripts/drain-protractor-backfill.ts"], {
      env: { ...process.env },
      stdio: "inherit",
    });

    const killer = setTimeout(() => {
      console.log(
        "[Worker drain-protractor] attempt budget exhausted, sending SIGTERM",
      );
      child.kill("SIGTERM");
    }, DRAIN_ATTEMPT_MAX_MS);

    child.on("exit", (code) => {
      clearTimeout(killer);
      const complete = code === 0;
      if (!complete) {
        // Don't re-enqueue here — let BullMQ's retry policy handle it.
        // The script's own lease/idempotency layer means a re-attempt
        // is safe.
      }
      resolve({ exitCode: code, complete });
    });

    child.on("error", (err) => {
      clearTimeout(killer);
      reject(err);
    });
  });
}
