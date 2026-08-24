import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  listSlowQueries,
  summarizeSlowQueries,
} from "@/lib/data/repositories/slow-queries";
import {
  slowQueryThresholdMs,
  slowQueryTrackingEnabled,
} from "@/lib/slow-query/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
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
    const { searchParams } = new URL(request.url);
    const view = searchParams.get("view") || "list";
    const hours = Math.min(
      Math.max(parseInt(searchParams.get("hours") || "24", 10) || 24, 1),
      24 * 30,
    );
    const dbParam = searchParams.get("db");
    const db = dbParam === "mongo" || dbParam === "pg" ? dbParam : undefined;

    const config = {
      enabled: slowQueryTrackingEnabled(),
      thresholdMs: slowQueryThresholdMs(),
    };

    if (view === "summary") {
      const shapes = await summarizeSlowQueries({ sinceHours: hours, db, limit: 50 });
      return NextResponse.json({ config, shapes });
    }

    const result = await listSlowQueries({
      sinceHours: hours,
      db,
      target: searchParams.get("target") || undefined,
      q: searchParams.get("q") || undefined,
      sort: searchParams.get("sort") === "ts" ? "ts" : "duration",
      limit: parseInt(searchParams.get("limit") || "50", 10) || 50,
      offset: parseInt(searchParams.get("offset") || "0", 10) || 0,
    });
    return NextResponse.json({ config, ...result });
  } catch (error: any) {
    console.error("[Platform Admin] slow-queries error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
