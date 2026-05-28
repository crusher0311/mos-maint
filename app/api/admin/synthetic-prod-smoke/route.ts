import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read-only status endpoint for the task #512 synthetic prod smoke.
 *
 * Returns the most recent N runs, last-known state per step, and a 24h
 * pass-rate roll-up. Powers the `/admin/synthetic-prod-smoke` tile.
 */
export async function GET(req: NextRequest) {
  const session = await requireSession();
  if (session.role !== "admin" && session.role !== "platform_admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const runLimit = Math.max(
    1,
    Math.min(500, Number(url.searchParams.get("runs") || 100)),
  );

  const db = await getDb();
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [runs, state, dayAgg] = await Promise.all([
    db
      .collection("synthetic_runs")
      .find({})
      .sort({ ts: -1 })
      .limit(runLimit)
      .toArray(),
    db.collection("synthetic_state").find({}).toArray(),
    db
      .collection("synthetic_runs")
      .aggregate([
        { $match: { ts: { $gte: since24h } } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            passed: { $sum: { $cond: ["$ok", 1, 0] } },
            avgDurationMs: { $avg: "$durationMs" },
          },
        },
      ])
      .toArray(),
  ]);

  const dayStats = dayAgg[0] || { total: 0, passed: 0, avgDurationMs: 0 };
  const passRate24h = dayStats.total
    ? dayStats.passed / dayStats.total
    : null;

  return NextResponse.json({
    ok: true,
    last24h: {
      total: dayStats.total,
      passed: dayStats.passed,
      passRate: passRate24h,
      avgDurationMs: Math.round(dayStats.avgDurationMs || 0),
    },
    state: state.map((s: any) => ({
      step: s.stepName ?? String(s._id).replace(/^step:/, "").replace(/:[^:]+$/, ""),
      // task #525 — per-(step × vendor) state. Derive vendor from the stored
      // field or the `step:<name>:<vendor>` id; older single-sentinel docs
      // keyed `step:<name>` have no vendor suffix.
      provider:
        s.provider ??
        (/:/.test(String(s._id).replace(/^step:/, ""))
          ? String(s._id).split(":").pop()
          : null),
      consecutiveFailures: s.consecutiveFailures || 0,
      alertedAt: s.alertedAt || null,
      lastFailureAt: s.lastFailureAt || null,
      lastRecoveredAt: s.lastRecoveredAt || null,
      lastError: s.lastError || null,
      lastStatus: s.lastStatus ?? null,
    })),
    runs: runs.map((r: any) => ({
      ts: r.ts,
      ok: r.ok,
      durationMs: r.durationMs,
      // Per-vendor grouping (task #525). Fall back to a single synthetic
      // "vendor" built from the legacy flattened `steps` for older run docs.
      vendors: Array.isArray(r.vendors)
        ? r.vendors.map((v: any) => ({
            provider: v.provider,
            shopId: v.shopId ?? null,
            vin: v.vin ?? null,
            ok: v.ok,
            steps: (v.steps || []).map((s: any) => ({
              name: s.name,
              ok: s.ok,
              latencyMs: s.latencyMs,
              status: s.status ?? null,
              error: s.error ?? null,
            })),
          }))
        : [
            {
              provider: r.provider ?? "legacy",
              shopId: r.shopId ?? null,
              vin: r.vin ?? null,
              ok: r.ok,
              steps: (r.steps || []).map((s: any) => ({
                name: s.name,
                ok: s.ok,
                latencyMs: s.latencyMs,
                status: s.status ?? null,
                error: s.error ?? null,
              })),
            },
          ],
      // Legacy flattened step list retained for back-compat consumers.
      steps: (r.steps || []).map((s: any) => ({
        name: s.name,
        ok: s.ok,
        latencyMs: s.latencyMs,
        status: s.status ?? null,
        error: s.error ?? null,
      })),
    })),
  });
}
