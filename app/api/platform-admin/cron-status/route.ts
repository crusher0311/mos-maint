import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import path from "path";
import { estimateScheduleInterval } from "@/lib/cron/schedule-interval";

type CronJobDef = {
  name: string;
  schedule: string;
  method?: string;
  path: string;
};

// Use eval("require") so webpack doesn't try to statically resolve the .cjs
// path at build time (mirrors the pattern in src/instrumentation.ts which
// loads the same file). Cached on the module so we only pay the cost once.
let cachedJobs: CronJobDef[] | null = null;
function loadCronJobs(): CronJobDef[] {
  if (cachedJobs) return cachedJobs;
  const nodeRequire = eval("require") as NodeRequire;
  const jobsPath = path.join(process.cwd(), "lib/cron/jobs.cjs");
  const mod = nodeRequire(jobsPath) as { CRON_JOBS: CronJobDef[] };
  cachedJobs = mod.CRON_JOBS;
  return cachedJobs;
}

// The cron scheduler (lib/cron/scheduler.cjs) and the instrumentation hook
// both write to the "mos" database (matching the existing cron_locks
// collection). The default getDb() resolves to "mos-maintenance-mvp", so we
// pin this reader explicitly to keep writers and readers in sync.
const CRON_DB = "mos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUS_COLLECTION = "cron_status";
const LOCK_COLLECTION = "cron_locks";
const STATUS_DOC_ID = "global";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.isPlatformAdmin) {
    return NextResponse.json(
      { error: "Forbidden - platform admin access required" },
      { status: 403 },
    );
  }

  try {
    const db = await getDb(CRON_DB);
    const now = new Date();
    const [doc, locks] = await Promise.all([
      db.collection(STATUS_COLLECTION).findOne({ _id: STATUS_DOC_ID as any }),
      db
        .collection(LOCK_COLLECTION)
        .find({ expiresAt: { $gt: now } })
        .toArray(),
    ]);

    const lastBoot = (doc as any)?.lastBoot ?? null;
    const bootHistory = (doc as any)?.bootHistory ?? [];
    const lastRunsObj = (doc as any)?.lastRuns ?? {};
    const lastRuns = Object.entries(lastRunsObj).map(
      ([name, value]: [string, any]) => ({ name, ...value }),
    );

    const nowMs = now.getTime();
    const oneHourMs = 60 * 60 * 1000;
    const bootedRecently =
      lastBoot &&
      lastBoot.status === "running" &&
      nowMs - new Date(lastBoot.bootedAt).getTime() < 24 * oneHourMs;
    const sinceBootMs = lastBoot
      ? nowMs - new Date(lastBoot.bootedAt).getTime()
      : null;

    // Pull the most recent successful run per job from
    // `cron_status.lastSuccessByJob` (written by `lib/cron/scheduler.cjs#recordRun`
    // on every successful run). Previously this aggregated the `cron_runs`
    // TTL collection — in prod that collection is missing entirely (task #449
    // / diagnosis #443), so the Cron Health tab rendered every job STALE and
    // hid the real wedged-lock outage for 9+ days. Reading the sibling field
    // on the same status doc we just loaded for `lastBoot` removes the dead
    // dependency and is also one fewer round-trip. Task #458.
    const cronJobs = loadCronJobs();
    const lastSuccessMap = ((doc as any)?.lastSuccessByJob || {}) as Record<
      string,
      Date | string
    >;
    const lastSuccessByJob = new Map<string, Date>();
    for (const [name, ts] of Object.entries(lastSuccessMap)) {
      const d = ts instanceof Date ? ts : new Date(ts as any);
      if (!isNaN(d.getTime())) lastSuccessByJob.set(name, d);
    }

    const jobsHealth = cronJobs.map((job) => {
      const interval = estimateScheduleInterval(job.schedule);
      const lastSuccessAt = lastSuccessByJob.get(job.name) ?? null;
      const lastSuccessAgeMs = lastSuccessAt
        ? nowMs - lastSuccessAt.getTime()
        : null;
      const staleThresholdMs = interval.intervalMs
        ? interval.intervalMs * 2
        : null;

      let stale = false;
      if (interval.weekendOnly) {
        // Weekend-only jobs are silent Mon-Fri by design — never flag stale.
        stale = false;
      } else if (staleThresholdMs && !lastSuccessAt) {
        // Never seen a success — only flag once we've been booted long enough
        // for one to plausibly have happened.
        stale = sinceBootMs !== null && sinceBootMs > staleThresholdMs;
      } else if (staleThresholdMs && lastSuccessAgeMs !== null) {
        stale = lastSuccessAgeMs > staleThresholdMs;
      }

      return {
        name: job.name,
        schedule: job.schedule,
        scheduleDescription: interval.description,
        intervalMs: interval.intervalMs,
        weekendOnly: interval.weekendOnly,
        lastSuccessAt: lastSuccessAt?.toISOString() ?? null,
        lastSuccessAgeMs,
        staleThresholdMs,
        stale,
      };
    });
    const staleJobs = jobsHealth.filter((j) => j.stale);

    let health: "ok" | "warn" | "fail" = "fail";
    let healthReason = "No scheduler boot record found";
    if (lastBoot) {
      if (lastBoot.status === "failed") {
        health = "fail";
        healthReason = `Last boot failed: ${lastBoot.error || "unknown error"}`;
      } else if (lastBoot.status === "disabled") {
        health = "warn";
        healthReason = `Scheduler disabled: ${lastBoot.reason || "no reason given"}`;
      } else if (lastBoot.status === "running") {
        const everyJobFailed =
          lastRuns.length > 0 && lastRuns.every((r) => r.ok === false);
        if (staleJobs.length > 0) {
          health = "fail";
          healthReason = `${staleJobs.length} job(s) stale: ${staleJobs
            .map((j) => j.name)
            .join(", ")}`;
        } else if (everyJobFailed) {
          health = "warn";
          healthReason = "All recorded job runs are failing";
        } else {
          health = "ok";
          healthReason = bootedRecently
            ? "Scheduler running normally"
            : "Scheduler running but boot record is stale";
        }
      }
    }

    return NextResponse.json({
      health,
      healthReason,
      lastBoot,
      sinceBootMs,
      bootHistory,
      lastRuns: lastRuns.sort((a, b) => a.name.localeCompare(b.name)),
      jobsHealth: jobsHealth.sort((a, b) => a.name.localeCompare(b.name)),
      staleJobs,
      activeLocks: locks.map((l: any) => ({
        jobName: l._id,
        instanceId: l.instanceId,
        lockedAt: l.lockedAt,
        expiresAt: l.expiresAt,
      })),
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Failed to read cron status" },
      { status: 500 },
    );
  }
}
