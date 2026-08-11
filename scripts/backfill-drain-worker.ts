#!/usr/bin/env npx tsx
// Backfill Drain Worker
//
// Long-running loop that runs the protractor + tekmetric drain scripts in
// PARALLEL, each with its own independent retry loop. Designed to run on
// a dedicated Render Background Worker service so it survives web-service
// deploys, OOMs, and restarts.
//
// Per provider, independently:
//   1. Spawn `npm run drain:<provider>-backfill`
//   2. Wait for the child to exit
//   3. Sleep IDLE_BETWEEN_LOOPS_MS (or BACKOFF_ON_FAILURE_MS on error,
//      or SHORT_RETRY_ON_LOCK_HELD_MS if exit code matches the special
//      "another drain owns the lock" code from drain-tekmetric-backfill)
//   4. Repeat
//
// Why independent loops (was: `await Promise.all([...])` per iteration):
//   The old shape made the SLOWEST provider gate the FASTEST provider's
//   retry cadence. Concrete failure (May 20 2026): Tekmetric drain
//   crashed in <3s on a stale-lock E11000, but Protractor kept running
//   for ~15h, so Tekmetric never got respawned and was effectively
//   offline. Independent loops mean a crash in one provider only
//   delays THAT provider by its own backoff.
//
// The drain scripts use Mongo-backed leases so this is safe to run
// alongside the existing web cron — only one drain process per provider
// can hold the lease.
//
// Stop behavior:
//   * SIGTERM (Render's graceful stop): forwards SIGTERM to every live
//     drain child's process group, then exits after a grace period.
//   * SIGINT (Ctrl-C): same as SIGTERM.
//   * If a child exits non-zero, that provider's loop logs and sleeps
//     BACKOFF_ON_FAILURE_MS before respawning. Lock-held (code 75) gets
//     a shorter SHORT_RETRY_ON_LOCK_HELD_MS so we re-attempt promptly
//     once the previous owner's lease expires.

import { spawn, type ChildProcess } from "node:child_process";

const IDLE_BETWEEN_LOOPS_MS = parseInt(
  process.env.BACKFILL_WORKER_IDLE_BETWEEN_LOOPS_MS || "300000",
  10,
);
const BACKOFF_ON_FAILURE_MS = parseInt(
  process.env.BACKFILL_WORKER_BACKOFF_ON_FAILURE_MS || "120000",
  10,
);
// Special exit code from drain-tekmetric-backfill.ts when another live
// drain owns the global lock. Short retry (default 90s) so we pick up
// promptly after the previous owner's 5-min TTL expires.
const DRAIN_LOCK_HELD_EXIT_CODE = 75;
const SHORT_RETRY_ON_LOCK_HELD_MS = parseInt(
  process.env.BACKFILL_WORKER_LOCK_HELD_RETRY_MS || "90000",
  10,
);

const PROVIDERS: Array<{ name: string; script: string }> = [
  { name: "protractor", script: "drain:protractor-backfill" },
  { name: "tekmetric", script: "drain:tekmetric-backfill" },
];

let stopRequested = false;
// Track every live child so SIGTERM can fan out to all of them. Replaces
// the old single `currentChild` global which couldn't represent the
// parallel-loop topology.
const liveChildren = new Set<ChildProcess>();

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[backfill-drain-worker ${ts}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    // If stop requested mid-sleep, resolve early so the loop can exit.
    const checkInterval = setInterval(() => {
      if (stopRequested) {
        clearTimeout(t);
        clearInterval(checkInterval);
        resolve();
      }
    }, 1000);
    setTimeout(() => clearInterval(checkInterval), ms + 50);
  });
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  // Negative PID targets the entire process group created via `detached: true`.
  // Required so we kill the actual drain process (tsx/node grandchild),
  // not just the npm wrapper — otherwise the drain can survive as an orphan.
  try {
    process.kill(-pid, signal);
  } catch (err) {
    log(`killProcessGroup pid=${pid} sig=${signal} failed: ${(err as Error).message}`);
  }
}

function runDrain(providerName: string, scriptName: string): Promise<number> {
  return new Promise((resolve) => {
    log(`[${providerName}] spawning: npm run ${scriptName}`);
    const child = spawn("npm", ["run", scriptName], {
      stdio: ["ignore", "inherit", "inherit"],
      env: process.env,
      detached: true,
    });
    liveChildren.add(child);
    child.on("exit", (code, signal) => {
      liveChildren.delete(child);
      log(
        `[${providerName}] child exited: code=${code} signal=${signal ?? "none"}`,
      );
      resolve(code ?? (signal ? 130 : 1));
    });
    child.on("error", (err) => {
      liveChildren.delete(child);
      log(`[${providerName}] child error: ${err.message}`);
      resolve(1);
    });
  });
}

async function providerLoop(provider: { name: string; script: string }): Promise<void> {
  let iteration = 0;
  while (!stopRequested) {
    iteration += 1;
    log(`[${provider.name}] === iteration ${iteration} start ===`);
    const exitCode = await runDrain(provider.name, provider.script);
    if (stopRequested) break;

    let sleepMs: number;
    let reason: string;
    if (exitCode === 0) {
      sleepMs = IDLE_BETWEEN_LOOPS_MS;
      reason = "ok";
    } else if (exitCode === DRAIN_LOCK_HELD_EXIT_CODE) {
      sleepMs = SHORT_RETRY_ON_LOCK_HELD_MS;
      reason = "lock-held";
    } else {
      sleepMs = BACKOFF_ON_FAILURE_MS;
      reason = `failure(${exitCode})`;
    }
    log(
      `[${provider.name}] === iteration ${iteration} end (${reason}) — sleeping ${sleepMs}ms ===`,
    );
    await sleep(sleepMs);
  }
  log(`[${provider.name}] loop exiting (stop requested)`);
}

// Start the Tekmetric incremental-sync loop on THIS deployed worker
// service when the web hands ownership over via
// TEKMETRIC_INCREMENTAL_ON_WORKER=true. The flag suppresses every web
// invocation path (scheduler, daily-all, the route itself), so the
// replacement cycle MUST live in the process that actually runs in
// production — this drain worker — not only in the optional BullMQ
// worker entrypoint. Dynamic import keeps the heavy app import chain
// out of drain-only deployments when the flag is off. Exported for the
// entrypoint smoke test.
export async function maybeStartIncrementalLoop(): Promise<boolean> {
  if (process.env.TEKMETRIC_INCREMENTAL_ON_WORKER !== "true") return false;
  const { startTekmetricIncrementalLoop } = await import(
    "../workers/tekmetric-incremental-loop"
  );
  const started = startTekmetricIncrementalLoop();
  log(
    started
      ? "Tekmetric incremental-sync loop started on this worker (TEKMETRIC_INCREMENTAL_ON_WORKER=true)"
      : "TEKMETRIC_INCREMENTAL_ON_WORKER=true but incremental loop did not start",
  );
  return started;
}

async function main(): Promise<void> {
  log("starting");
  log(
    `config: idleBetweenLoops=${IDLE_BETWEEN_LOOPS_MS}ms backoffOnFailure=${BACKOFF_ON_FAILURE_MS}ms shortRetryOnLockHeld=${SHORT_RETRY_ON_LOCK_HELD_MS}ms`,
  );
  await maybeStartIncrementalLoop();
  log(
    `running ${PROVIDERS.length} providers in independent parallel loops: ${PROVIDERS.map((p) => p.name).join(", ")}`,
  );
  await Promise.all(PROVIDERS.map((p) => providerLoop(p)));
  log("all provider loops exited");
  process.exit(0);
}

// Render gives roughly 30s between SIGTERM and SIGKILL. Force-kill our
// drain process groups a bit before that so we exit cleanly rather than
// getting hard-killed mid-write.
const SHUTDOWN_GRACE_MS = parseInt(
  process.env.BACKFILL_WORKER_SHUTDOWN_GRACE_MS || "25000",
  10,
);

function requestStop(signal: string): void {
  if (stopRequested) {
    log(`received ${signal} again; forcing immediate exit`);
    for (const child of liveChildren) {
      if (child.pid) killProcessGroup(child.pid, "SIGKILL");
    }
    process.exit(130);
  }
  log(
    `received ${signal}; signaling ${liveChildren.size} drain child(ren) then exiting in <=${SHUTDOWN_GRACE_MS}ms`,
  );
  stopRequested = true;
  for (const child of liveChildren) {
    if (child.pid) killProcessGroup(child.pid, "SIGTERM");
  }
  // Bounded grace: if any drain doesn't exit cleanly, force-kill the groups
  // before Render does it for us.
  const forceKillTimer = setTimeout(() => {
    for (const child of liveChildren) {
      if (child.pid) {
        log(`shutdown grace expired; SIGKILL'ing drain child pid=${child.pid}`);
        killProcessGroup(child.pid, "SIGKILL");
      }
    }
    setTimeout(() => process.exit(130), 2000).unref();
  }, SHUTDOWN_GRACE_MS);
  forceKillTimer.unref();
}

// Only auto-run (and trap signals) when executed directly — the module is
// also imported by the entrypoint smoke test, which must not spawn drain
// children.
const isDirectRun = process.argv[1]
  ? import.meta.url === new URL(`file://${process.argv[1]}`).href ||
    process.argv[1].endsWith("backfill-drain-worker.ts")
  : false;

if (isDirectRun) {
  process.on("SIGTERM", () => requestStop("SIGTERM"));
  process.on("SIGINT", () => requestStop("SIGINT"));

  main().catch((err) => {
    log(`FATAL: ${err?.message || String(err)}`);
    console.error(err);
    process.exit(2);
  });
}
