import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  createAnnouncement,
  getAnnouncements,
  sendAnnouncement,
  deleteAnnouncement,
  getTargetedUsers,
  type AnnouncementTarget,
  type AnnouncementPriority,
} from "@/lib/announcements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session || !session.isPlatformAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const limit = parseInt(searchParams.get("limit") || "50");
    const status = searchParams.get("status") as "draft" | "sent" | undefined;

    const announcements = await getAnnouncements(limit, status);

    return NextResponse.json({ announcements });
  } catch (error) {
    console.error("Error fetching announcements:", error);
    return NextResponse.json({ error: "Failed to fetch announcements" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session || !session.isPlatformAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { title, message, priority, target, deliveryChannels, sendNow, previewOnly } = body;

    if (!target) {
      return NextResponse.json({ error: "Missing target configuration" }, { status: 400 });
    }

    const targetConfig: AnnouncementTarget = {
      type: target.type,
      shopIds: target.shopIds,
      roles: target.roles,
      smsIntegrations: target.smsIntegrations,
    };

    if (previewOnly) {
      const recipients = await getTargetedUsers(targetConfig);
      return NextResponse.json({
        preview: true,
        recipientCount: recipients.length,
        sampleRecipients: recipients,
      });
    }

    if (!title || !message || !priority) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const announcementId = await createAnnouncement({
      title,
      message,
      priority: priority as AnnouncementPriority,
      target: targetConfig,
      deliveryChannels: deliveryChannels || { inApp: true, email: true },
      status: sendNow ? "sent" : "draft",
      createdBy: session.userId,
    });

    if (!announcementId) {
      return NextResponse.json({ error: "Failed to create announcement" }, { status: 500 });
    }

    if (sendNow) {
      const result = await sendAnnouncement(announcementId.toString());
      return NextResponse.json({
        success: true,
        announcementId: announcementId.toString(),
        sent: true,
        stats: result.stats,
      });
    }

    return NextResponse.json({
      success: true,
      announcementId: announcementId.toString(),
      sent: false,
    });
  } catch (error) {
    console.error("Error creating announcement:", error);
    return NextResponse.json({ error: "Failed to create announcement" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session || !session.isPlatformAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");

    if (!id) {
      return NextResponse.json({ error: "Missing announcement ID" }, { status: 400 });
    }

    const deleted = await deleteAnnouncement(id);
    if (!deleted) {
      return NextResponse.json({ error: "Announcement not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error deleting announcement:", error);
    return NextResponse.json({ error: "Failed to delete announcement" }, { status: 500 });
  }
}
