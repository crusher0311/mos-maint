// Sales-coach scenarios API (task #987). Platform-admin only — the route
// enforces its own authz (page-level guards are not enough for API routes).
import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/db/drizzle";
import { generateDailyScenarios } from "@/lib/sales-coach/scenario-sampler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function requirePlatformAdminApi(): Promise<NextResponse | null> {
  const session = await getSession();
  if (!session) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!session.isPlatformAdmin) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  return null;
}

/** GET — today's scenarios (falls back to the most recent day with any). */
export async function GET() {
  const denied = await requirePlatformAdminApi();
  if (denied) return denied;
  try {
    const db = getDb();
    const today = new Date().toISOString().slice(0, 10);
    let rows: any[] = await db.execute(sql`
      SELECT id, scenario_date, scenario_type, shop_id, work_order_number, context, created_at
      FROM sales_coach_scenarios WHERE scenario_date = ${today}
      ORDER BY created_at ASC
    `);
    let date = today;
    if (rows.length === 0) {
      const latest: any[] = await db.execute(sql`
        SELECT max(scenario_date) AS d FROM sales_coach_scenarios
      `);
      if (latest[0]?.d) {
        date = latest[0].d;
        rows = await db.execute(sql`
          SELECT id, scenario_date, scenario_type, shop_id, work_order_number, context, created_at
          FROM sales_coach_scenarios WHERE scenario_date = ${date}
          ORDER BY created_at ASC
        `);
      }
    }
    return NextResponse.json({
      ok: true,
      date,
      isToday: date === today,
      scenarios: rows.map((r) => ({
        id: r.id,
        scenarioDate: r.scenario_date,
        scenarioType: r.scenario_type,
        shopId: r.shop_id,
        workOrderNumber: r.work_order_number,
        context: r.context,
        createdAt: r.created_at,
      })),
    });
  } catch (err: any) {
    console.error("[SalesCoach] scenarios GET failed:", err?.message || err);
    return NextResponse.json({ ok: false, error: err?.message || "failed" }, { status: 500 });
  }
}

/** POST — manual "generate now" trigger for testing. */
export async function POST(req: NextRequest) {
  const denied = await requirePlatformAdminApi();
  if (denied) return denied;
  try {
    const result = await generateDailyScenarios(5);
    return NextResponse.json({ ok: true, ...result });
  } catch (err: any) {
    console.error("[SalesCoach] generate-now failed:", err?.message || err);
    return NextResponse.json({ ok: false, error: err?.message || "failed" }, { status: 500 });
  }
}
