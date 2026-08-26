import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { cancelReportRun, touchReportRun } from "@/lib/data/repositories/report-runs";
import { readableRunFor } from "@/lib/report-run-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const run = await readableRunFor(session as any, (await params).id).catch(() => null);
  if (!run) return NextResponse.json({ error: "Report run not found" }, { status: 404 });
  await touchReportRun(run._id);
  const stale = Boolean(run.generatedAt && Date.now() - run.generatedAt.getTime() >= 15 * 60_000);
  return NextResponse.json({
    ok: true, runId: run._id, status: run.status, stage: run.stage,
    attempts: run.attempts, queuedAt: run.queuedAt, startedAt: run.startedAt,
    completedAt: run.completedAt, generatedAt: run.generatedAt,
    stale, refreshing: run.status === "queued" || run.status === "running",
    result: run.result, error: run.error,
  });
}

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const run = await cancelReportRun((await params).id, session.email);
  return run ? NextResponse.json({ ok: true, status: run.status }) : NextResponse.json({ error: "Only queued runs can be cancelled" }, { status: 409 });
}