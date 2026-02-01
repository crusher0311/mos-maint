import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export async function GET() {
  try {
    await requirePlatformAdmin();

    const result = await sql<{count: string}[]>`
      SELECT COUNT(*) as count FROM support_tickets 
      WHERE status IN ('open', 'in_progress')
    `;

    const openCount = parseInt(result[0]?.count || "0", 10);

    return NextResponse.json({
      ok: true,
      openCount
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (message === "Unauthorized" || message === "Not a platform admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to get count" }, { status: 500 });
  }
}
