import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { ObjectId } from "mongodb";
import { deletePlatformAdminNotification, markPlatformAdminNotificationRead } from "@/lib/notifications";

export const __deps = {
  requirePlatformAdmin,
  deletePlatformAdminNotification,
  markPlatformAdminNotificationRead,
};

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await __deps.requirePlatformAdmin();
    
    const { id } = params;
    
    if (!ObjectId.isValid(id)) {
      return NextResponse.json({ ok: false, error: "Invalid notification ID" }, { status: 400 });
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
    }
    
    if (body && typeof body === "object" && "read" in body && body.read === true) {
      const changed = await __deps.markPlatformAdminNotificationRead(id);
      return NextResponse.json({ ok: true, changed });
    }

    return NextResponse.json({ ok: false, error: "Invalid update" }, { status: 400 });
  } catch (error: any) {
    if (error.message === "Unauthorized" || error.message === "Not a platform admin") {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error updating admin notification:", error);
    return NextResponse.json({ ok: false, error: "Failed to update notification" }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    await __deps.requirePlatformAdmin();
    
    const { id } = params;
    
    if (!ObjectId.isValid(id)) {
      return NextResponse.json({ ok: false, error: "Invalid notification ID" }, { status: 400 });
    }

    const deleted = await __deps.deletePlatformAdminNotification(id);
    return NextResponse.json({ ok: true, deleted });
  } catch (error: any) {
    if (error.message === "Unauthorized" || error.message === "Not a platform admin") {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error deleting admin notification:", error);
    return NextResponse.json({ ok: false, error: "Failed to delete notification" }, { status: 500 });
  }
}
