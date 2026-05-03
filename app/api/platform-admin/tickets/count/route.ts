import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { countSupportTickets } from "@/lib/data/repositories/support-tickets";

export async function GET() {
  try {
    await requirePlatformAdmin();

    const openCount = await countSupportTickets({
      status: { $in: ["open", "in_progress"] },
    });

    return NextResponse.json({
      ok: true,
      openCount,
    });
  } catch (error: any) {
    if (error.message === "Unauthorized" || error.message === "Not a platform admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to get count" }, { status: 500 });
  }
}
