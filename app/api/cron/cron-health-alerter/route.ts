import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { sendEmail } from "@/lib/email";
import { getPlatformAdminEmails } from "@/lib/super-admins";
import path from "path";
import { decideJobStale } from "@/lib/cron/staleness";

type CronJobDef = {
  name: string;
  schedule: string;
  path: string;
  // Optional per-job overrides declared in lib/cron/jobs.cjs.
  // `stalenessMs`: explicit staleness threshold (else 2× the schedule interval).
  // `tolerateTimeouts`: for self-throttling long-running jobs, a *recent
  //   timeout attempt* counts as a liveness heartbeat so the job isn't flagged
  //   stuck merely for never returning a clean 200 while it drains a backlog.
  stalenessMs?: number;
  tolerateTimeouts?: boolean;
};
let cachedJobs: CronJobDef[] | null = null;
function loadCronJobs(): CronJobDef[] {
  if (cachedJobs) return cachedJobs;
  const nodeRequire = eval("require") as NodeRequire;
  const jobsPath = path.join(process.cwd(), "lib/cron/jobs.cjs");
  cachedJobs = (nodeRequire(jobsPath) as { CRON_JOBS: CronJobDef[] }).CRON_JOBS;
  return cachedJobs;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Cron-health alerter — task #305.
//
// Walks every job registered in `lib/cron/jobs.cjs`, looks up the most recent
// successful run from the `cron_runs` time-series collection (TTL-7d, written
// by `lib/cron/scheduler.cjs`), and pages platform admins when any job's
// last success is older than 2× its schedule interval.
//
// Reuses the same email channel as the existing stuck-shop alerts (the
// tekmetric-backfill-health cron uses Resend via `lib/email.ts` against
// `getPlatformAdminEmails()`). State-based dedup so on-call isn't paged every
// 30 min for the same already-known stuck job: one row per jobName in
// `cron_health_alerts` keyed on `{ alertedAt, lastSuccessAt }`. Auto-clears
// when the job recovers (last success advances past the alerted timestamp).
//
// Auth: standard `Authorization: Bearer ${CRON_SECRET}` like the other crons.

const ALERTS_COLLECTION = "cron_health_alerts";

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  const secret = process.env.CRON_SECRET;
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await getDb("mos");
  const now = new Date();
  const nowMs = now.getTime();

  // Boot record gives us "scheduler is up at all". If there's no recent boot
  // we can't reason about staleness — skip silently rather than spam-paging.
  const statusDoc = await db
    .collection("cron_status")
    .findOne({ _id: "global" as any });
  const lastBoot = (statusDoc as any)?.lastBoot ?? null;
  const sinceBootMs = lastBoot
    ? nowMs - new Date(lastBoot.bootedAt).getTime()
    : null;
  if (!lastBoot || lastBoot.status !== "running") {
    return NextResponse.json({
      ok: true,
      skipped: "scheduler not in running state",
      lastBootStatus: lastBoot?.status ?? null,
    });
  }

  const cronJobs = loadCronJobs();
  // Read per-job last-success timestamps from the `cron_status.lastSuccessByJob`
  // map (written by `lib/cron/scheduler.cjs#recordRun` on every successful
  // run). Previously this aggregated the `cron_runs` TTL collection — in
  // prod that collection is missing entirely so the alerter never paged
  // (task #449 / diagnosis #443). The status doc is the same one we just
  // loaded for `lastBoot`, so this is also one fewer round-trip.
  const lastSuccessMap = ((statusDoc as any)?.lastSuccessByJob || {}) as Record<
    string,
    Date | string
  >;
  const lastSuccessByJob = new Map<string, Date>();
  for (const [name, ts] of Object.entries(lastSuccessMap)) {
    const d = ts instanceof Date ? ts : new Date(ts);
    if (!isNaN(d.getTime())) lastSuccessByJob.set(name, d);
  }

  // Latest *attempt* (regardless of outcome) from `cron_status.lastRuns`,
  // written by `lib/cron/scheduler.cjs#recordRun`. Used by the
  // `tolerateTimeouts` heartbeat below: a long, self-throttling backfill that
  // times out every pass while draining a backlog is still alive — only a
  // wedged scheduler (no recent attempt) or a real handler error (non-timeout
  // failure) should page for such a job.
  const lastRunsMap = ((statusDoc as any)?.lastRuns || {}) as Record<
    string,
    { dt?: Date | string; ok?: boolean; status?: number; error?: string }
  >;
  const lastAttemptByJob = new Map<
    string,
    { atMs: number; ok: boolean; timedOut: boolean }
  >();
  for (const [name, run] of Object.entries(lastRunsMap)) {
    if (!run || typeof run !== "object") continue;
    const dt = run.dt instanceof Date ? run.dt : new Date(run.dt ?? NaN);
    if (isNaN(dt.getTime())) continue;
    lastAttemptByJob.set(name, {
      atMs: dt.getTime(),
      ok: run.ok === true,
      timedOut: run.error === "timeout",
    });
  }

  const stale: Array<{
    name: string;
    schedule: string;
    intervalMs: number;
    lastSuccessAt: Date | null;
    ageMs: number | null;
  }> = [];

  for (const job of cronJobs) {
    const last = lastSuccessByJob.get(job.name) ?? null;
    const decision = decideJobStale({
      job,
      lastSuccessAtMs: last ? last.getTime() : null,
      lastAttempt: lastAttemptByJob.get(job.name) ?? null,
      sinceBootMs,
      nowMs,
    });
    if (!decision.evaluated || !decision.stale) continue;
    stale.push({
      name: job.name,
      schedule: job.schedule,
      intervalMs: decision.intervalMs!,
      lastSuccessAt: last,
      ageMs: decision.ageMs,
    });
  }

  // Auto-clear: any alert row whose underlying job has recovered (newer
  // success than what we paged on) gets deleted so we'll re-page if it
  // breaks again later.
  const existingAlerts = await db
    .collection(ALERTS_COLLECTION)
    .find({})
    .toArray();
  const cleared: string[] = [];
  for (const row of existingAlerts as any[]) {
    const stillStale = stale.find((s) => s.name === row.jobName);
    if (!stillStale) {
      await db
        .collection(ALERTS_COLLECTION)
        .deleteOne({ _id: row._id });
      cleared.push(row.jobName);
    }
  }

  // Decide which stale jobs are *new* alerts (or have a different
  // lastSuccessAt than what we last paged on).
  const toAlert: typeof stale = [];
  for (const s of stale) {
    const prior = existingAlerts.find((r: any) => r.jobName === s.name);
    const lastSuccessIso = s.lastSuccessAt?.toISOString() ?? null;
    if (
      !prior ||
      (prior as any).lastSuccessAt !== lastSuccessIso
    ) {
      toAlert.push(s);
      await db.collection(ALERTS_COLLECTION).updateOne(
        { jobName: s.name },
        {
          $set: {
            jobName: s.name,
            lastSuccessAt: lastSuccessIso,
            schedule: s.schedule,
            intervalMs: s.intervalMs,
            alertedAt: now,
          },
        },
        { upsert: true },
      );
    }
  }

  let emailed = 0;
  if (toAlert.length > 0) {
    const admins = await getPlatformAdminEmails();
    const rows = toAlert
      .map(
        (s) => `
        <tr>
          <td style="padding:6px 12px;border-bottom:1px solid #eee"><code>${s.name}</code></td>
          <td style="padding:6px 12px;border-bottom:1px solid #eee">${s.schedule}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #eee">${
            s.lastSuccessAt
              ? `${Math.round((s.ageMs || 0) / 60000)} min ago`
              : "never"
          }</td>
          <td style="padding:6px 12px;border-bottom:1px solid #eee">${Math.round(
            s.intervalMs / 60000,
          )} min</td>
        </tr>`,
      )
      .join("");
    const html = `
      <div style="font-family:system-ui,sans-serif;max-width:720px">
        <h2 style="color:#b91c1c;margin:0 0 8px">Cron jobs stuck</h2>
        <p style="color:#444;margin:0 0 16px">
          ${toAlert.length} job(s) have not succeeded in 2× their scheduled interval.
          The in-process scheduler may be wedged, the underlying handler may be
          erroring, or the Mongo distributed lock may be stuck. Investigate before
          dependent data goes stale.
        </p>
        <table style="border-collapse:collapse;width:100%;font-size:14px">
          <thead><tr style="background:#fafafa;text-align:left">
            <th style="padding:6px 12px">Job</th>
            <th style="padding:6px 12px">Schedule</th>
            <th style="padding:6px 12px">Last success</th>
            <th style="padding:6px 12px">Interval</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="margin-top:16px;color:#666;font-size:13px">
          Sent by <code>/api/cron/cron-health-alerter</code>. Diagnostics:
          <code>/dashboard/admin/observability</code> → "Cron Scheduler" tab.
          Already-stale jobs with unchanged last-success timestamps are deduped —
          you'll only be re-paged when the situation changes or the job recovers
          and breaks again.
        </p>
      </div>`;
    for (const email of admins) {
      try {
        await sendEmail({
          to: email,
          subject: `[MOS] Cron stuck: ${toAlert
            .map((s) => s.name)
            .join(", ")}`,
          html,
        });
        emailed++;
      } catch (err: any) {
        console.error(
          `[CronHealthAlerter] Email send failed for ${email}:`,
          err?.message,
        );
      }
    }
  }

  return NextResponse.json({
    ok: true,
    staleCount: stale.length,
    alertedCount: toAlert.length,
    clearedCount: cleared.length,
    emailed,
    stale: stale.map((s) => s.name),
    cleared,
  });
}
