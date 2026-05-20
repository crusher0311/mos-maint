#!/usr/bin/env npx tsx
// Backfill Drain Worker
//
// Long-running loop that runs the protractor + tekmetric drain scripts back-
// to-back forever. Designed to run on a dedicated Render Background Worker
// service so it survives web-service deploys, OOMs, and restarts.
//
// Each iteration:
//   1. Run `npm run drain:protractor-backfill` to completion
//   2. Sleep IDLE_BETWEEN_PROVIDERS_MS
//   3. Run `npm run drain:tekmetric-backfill` to completion
//   4. Sleep IDLE_BETWEEN_LOOPS_MS, then repeat
//
// The drain scripts already use Mongo-backed leases to prevent concurrent
// runs, so this worker is safe to start even if a stray drain is running
// elsewhere — it will simply wait its turn.
//
// Stop behavior:
//   * SIGTERM (Render's graceful stop): finishes the current child, then
//     exits cleanly. Render allows ~30s for this.
//   * SIGINT (Ctrl-C): same as SIGTERM.
//   * If a child exits with a non-zero status, we log it and continue the
//     loop after a backoff. We do NOT exit — Render would just restart us
//     anyway and we'd lose the in-memory backoff.

import { spawn, type ChildProcess } from "node:child_process";

const IDLE_BETWEEN_PROVIDERS_MS = parseInt(
  process.env.BACKFILL_WORKER_IDLE_BETWEEN_PROVIDERS_MS || "60000",
  10,
);
const IDLE_BETWEEN_LOOPS_MS = parseInt(
  process.env.BACKFILL_WORKER_IDLE_BETWEEN_LOOPS_MS || "300000",
  10,
);
const BACKOFF_ON_FAILURE_MS = parseInt(
  process.env.BACKFILL_WORKER_BACKOFF_ON_FAILURE_MS || "120000",
  10,
);

const PROVIDERS: Array<{ name: string; script: string }> = [
  { name: "protractor", script: "drain:protractor-backfill" },
  { name: "tekmetric", script: "drain:tekmetric-backfill" },
];

let stopRequested = false;
let currentChild: ChildProcess | null = null;

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
    // Make sure interval cleared on normal completion.
    setTimeout(() => clearInterval(checkInterval), ms + 50);
  });
}

function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
  // Negative PID targets the entire process group created via `detached: true`.
  // This is required so we kill the actual drain process (tsx/node grandchild),
  // not just the npm wrapper — otherwise the drain can survive as an orphan.
  try {
    process.kill(-pid, signal);
  } catch (err) {
    log(`killProcessGroup pid=${pid} sig=${signal} failed: ${(err as Error).message}`);
  }
}

function runDrain(scriptName: string): Promise<number> {
  return new Promise((resolve) => {
    log(`spawning: npm run ${scriptName}`);
    const child = spawn("npm", ["run", scriptName], {
      stdio: ["ignore", "inherit", "inherit"],
      env: process.env,
      detached: true, // create a new process group so we can signal the grandchild
    });
    currentChild = child;
    child.on("exit", (code, signal) => {
      currentChild = null;
      log(
        `child exited: script=${scriptName} code=${code} signal=${signal ?? "none"}`,
      );
      resolve(code ?? (signal ? 130 : 1));
    });
    child.on("error", (err) => {
      currentChild = null;
      log(`child error: script=${scriptName} err=${err.message}`);
      resolve(1);
    });
  });
}

async function main(): Promise<void> {
  log("starting");
  log(
    `config: idleBetweenProviders=${IDLE_BETWEEN_PROVIDERS_MS}ms idleBetweenLoops=${IDLE_BETWEEN_LOOPS_MS}ms backoffOnFailure=${BACKOFF_ON_FAILURE_MS}ms`,
  );

  let iteration = 0;
  while (!stopRequested) {
    iteration += 1;
    log(`=== iteration ${iteration} start ===`);
    log(`spawning ${PROVIDERS.length} providers in parallel: ${PROVIDERS.map((p) => p.name).join(", ")}`);
    const results = await Promise.all(
      PROVIDERS.map(async (provider) => {
        if (stopRequested) return { provider, exitCode: 0 };
        const exitCode = await runDrain(provider.script);
        if (exitCode !== 0) {
          log(`provider=${provider.name} drain exited non-zero (${exitCode})`);
        }
        return { provider, exitCode };
      }),
    );
    const anyFailed = results.some((r) => r.exitCode !== 0);
    if (stopRequested) break;
    const sleepMs = anyFailed ? BACKOFF_ON_FAILURE_MS : IDLE_BETWEEN_LOOPS_MS;
    log(
      `=== iteration ${iteration} end (anyFailed=${anyFailed}) — sleeping ${sleepMs}ms ===`,
    );
    await sleep(sleepMs);
  }

  log("stop requested; exiting cleanly");
  process.exit(0);
}

// Render gives roughly 30s between SIGTERM and SIGKILL. Force-kill our drain
// process group a bit before that so we exit cleanly rather than getting
// hard-killed mid-write.
const SHUTDOWN_GRACE_MS = parseInt(
  process.env.BACKFILL_WORKER_SHUTDOWN_GRACE_MS || "25000",
  10,
);

function requestStop(signal: string): void {
  if (stopRequested) {
    log(`received ${signal} again; forcing immediate exit`);
    if (currentChild?.pid) killProcessGroup(currentChild.pid, "SIGKILL");
    process.exit(130);
  }
  log(
    `received ${signal}; signaling drain process group then exiting in <=${SHUTDOWN_GRACE_MS}ms`,
  );
  stopRequested = true;
  if (currentChild?.pid) {
    // Forward SIGTERM to the whole process group so the actual drain
    // (tsx/node grandchild) gets the signal, not just the npm wrapper.
    killProcessGroup(currentChild.pid, "SIGTERM");
    // Bounded grace: if the drain doesn't exit cleanly, force-kill the group
    // before Render does it for us.
    const forceKillTimer = setTimeout(() => {
      if (currentChild?.pid) {
        log(`shutdown grace expired; SIGKILL'ing drain process group`);
        killProcessGroup(currentChild.pid, "SIGKILL");
      }
      // Hard-exit shortly after in case main() is wedged on the sleep loop.
      setTimeout(() => process.exit(130), 2000).unref();
    }, SHUTDOWN_GRACE_MS);
    forceKillTimer.unref();
  } else {
    // No child running — exit immediately after letting any current sleep wake.
    setTimeout(() => process.exit(0), 1500).unref();
  }
}

process.on("SIGTERM", () => requestStop("SIGTERM"));
process.on("SIGINT", () => requestStop("SIGINT"));

main().catch((err) => {
  log(`FATAL: ${err?.message || String(err)}`);
  console.error(err);
  process.exit(2);
});
