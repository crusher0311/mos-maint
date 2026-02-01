import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await sql<{count: string}[]>`
      SELECT COUNT(*) as count FROM support_tickets 
      WHERE user_email = ${session.email} AND status IN ('open', 'in_progress')
    `;

    const openCount = parseInt(result[0]?.count || "0", 10);

    return NextResponse.json({
      ok: true,
      openCount
    });
  } catch (error: unknown) {
    console.error("Error getting ticket count:", error);
    return NextResponse.json({ error: "Failed to get count" }, { status: 500 });
  }
}
