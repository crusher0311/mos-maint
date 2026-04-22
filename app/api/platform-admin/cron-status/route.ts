import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

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
        const stale = lastRuns.find(
          (r) =>
            r.dt && now - new Date(r.dt).getTime() > 2 * oneHourMs && !r.ok,
        );
        const everyJobFailed =
          lastRuns.length > 0 && lastRuns.every((r) => r.ok === false);
        if (stale || everyJobFailed) {
          health = "warn";
          healthReason = stale
            ? `Job ${stale.name} hasn't succeeded recently`
            : "All recorded job runs are failing";
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
