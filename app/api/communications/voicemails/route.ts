import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { listCommVoicemails } from "@/lib/db/repositories/comm-voicemails";
import { ensureCommunicationsTables } from "@/lib/db/init";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    await ensureCommunicationsTables();

    const { searchParams } = req.nextUrl;
    const status = searchParams.get("status") || undefined;
    const limit = parseInt(searchParams.get("limit") || "50", 10);
    const offset = parseInt(searchParams.get("offset") || "0", 10);

    const voicemails = await listCommVoicemails(session.shopId, {
      status,
      limit,
      offset,
    });

    return NextResponse.json({ voicemails });
  } catch (error: any) {
    console.error("List voicemails error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to list voicemails" },
      { status: 500 }
    );
  }
}
