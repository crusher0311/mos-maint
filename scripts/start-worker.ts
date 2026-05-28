#!/usr/bin/env tsx
/**
 * Backfill worker launcher (task #513).
 *
 * Convenience wrapper around `workers/worker.ts` for local dev and
 * single-process Render deployments. Production deploys should run
 * `tsx workers/worker.ts` directly as the Render service's start
 * command so the process tree is one level shallower.
 */

import { startWorkers } from "../workers/worker";

startWorkers().catch((err) => {
  console.error("[start-worker] Fatal:", err);
  process.exit(1);
});
