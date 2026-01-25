import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getQueryStats, getSlowQueries, clearSlowQueries } from "@/lib/query-monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await getSession();
    if (!session || session.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const stats = getQueryStats();
    const recentQueries = getSlowQueries().slice(-20);

    return NextResponse.json({
      stats,
      recentQueries,
    });
  } catch (error) {
    console.error("Query stats error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  try {
    const session = await getSession();
    if (!session || session.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    clearSlowQueries();

    return NextResponse.json({ message: "Slow query log cleared" });
  } catch (error) {
    console.error("Clear query stats error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
