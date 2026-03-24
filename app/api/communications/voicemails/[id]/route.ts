import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getCommVoicemail, updateCommVoicemailStatus } from "@/lib/db/repositories/comm-voicemails";
import { ensureCommunicationsTables } from "@/lib/db/init";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    await ensureCommunicationsTables();

    const voicemail = await getCommVoicemail(params.id);
    if (!voicemail) {
      return NextResponse.json({ error: "Voicemail not found" }, { status: 404 });
    }

    if (voicemail.shop_id !== session.shopId && !session.isPlatformAdmin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    return NextResponse.json({ voicemail });
  } catch (error: any) {
    console.error("Get voicemail error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to get voicemail" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    await ensureCommunicationsTables();

    const existing = await getCommVoicemail(params.id);
    if (!existing) {
      return NextResponse.json({ error: "Voicemail not found" }, { status: 404 });
    }

    if (existing.shop_id !== session.shopId && !session.isPlatformAdmin) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await req.json();
    const validStatuses = ["new", "listened", "archived"] as const;
    if (!body.status || !validStatuses.includes(body.status)) {
      return NextResponse.json(
        { error: "Invalid status. Must be: new, listened, or archived" },
        { status: 400 }
      );
    }

    const voicemail = await updateCommVoicemailStatus(params.id, body.status);

    return NextResponse.json({ voicemail });
  } catch (error: any) {
    console.error("Update voicemail error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to update voicemail" },
      { status: 500 }
    );
  }
}
