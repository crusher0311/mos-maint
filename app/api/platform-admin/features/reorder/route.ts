import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { ObjectId } from "mongodb";
import { bulkWritePlatformFeatures } from "@/lib/data/repositories/platform-features";

export async function POST(request: NextRequest) {
  try {
    await requirePlatformAdmin();

    const body = await request.json();
    const { orderedIds } = body;

    if (!orderedIds || !Array.isArray(orderedIds)) {
      return NextResponse.json({ error: "orderedIds array is required" }, { status: 400 });
    }

    const bulkOps = orderedIds.map((id: string, index: number) => ({
      updateOne: {
        filter: { _id: new ObjectId(id) },
        update: { $set: { order: index + 1, updatedAt: new Date() } },
      },
    }));

    await bulkWritePlatformFeatures(bulkOps);

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("Error reordering features:", error);
    if (error.message === "Unauthorized" || error.message === "Not a platform admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Failed to reorder features" }, { status: 500 });
  }
}
