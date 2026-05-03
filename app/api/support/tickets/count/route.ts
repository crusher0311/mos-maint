import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { countSupportTickets } from "@/lib/data/repositories/support-tickets";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const openCount = await countSupportTickets({
      userEmail: session.email,
      status: { $in: ["open", "in_progress"] },
    });

    return NextResponse.json({
      ok: true,
      openCount,
    });
  } catch (error: any) {
    return NextResponse.json({ error: "Failed to get count" }, { status: 500 });
  }
}
