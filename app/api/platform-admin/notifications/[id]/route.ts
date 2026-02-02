import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { ObjectId } from "mongodb";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await requirePlatformAdmin();
    
    const { id } = params;
    
    if (!ObjectId.isValid(id)) {
      return NextResponse.json({ ok: false, error: "Invalid notification ID" }, { status: 400 });
    }

    const body = await req.json();
    
    if (body.read === true) {
      const db = await getDb();
      const result = await db.collection("notifications").updateOne(
        { _id: new ObjectId(id), userId: `admin:${session.email}` },
        { $set: { read: true } }
      );
      return NextResponse.json({ ok: result.modifiedCount > 0 });
    }

    return NextResponse.json({ ok: false, error: "Invalid update" }, { status: 400 });
  } catch (error: any) {
    console.error("Error updating admin notification:", error);
    if (error.message === "Unauthorized" || error.message === "Not a platform admin") {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: "Failed to update notification" }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await requirePlatformAdmin();
    
    const { id } = params;
    
    if (!ObjectId.isValid(id)) {
      return NextResponse.json({ ok: false, error: "Invalid notification ID" }, { status: 400 });
    }

    const db = await getDb();
    const result = await db.collection("notifications").deleteOne({
      _id: new ObjectId(id),
      userId: `admin:${session.email}`,
    });
    
    return NextResponse.json({ ok: result.deletedCount > 0 });
  } catch (error: any) {
    console.error("Error deleting admin notification:", error);
    if (error.message === "Unauthorized" || error.message === "Not a platform admin") {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: "Failed to delete notification" }, { status: 500 });
  }
}
