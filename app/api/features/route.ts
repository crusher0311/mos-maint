import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = await getDb();
    const features = await db.collection("platform_features")
      .find({ status: "active" })
      .sort({ order: 1 })
      .project({
        _id: 1,
        name: 1,
        slug: 1,
        description: 1,
        icon: 1,
        includedInTiers: 1,
        category: 1
      })
      .toArray();

    return NextResponse.json({
      ok: true,
      features
    });
  } catch (error) {
    console.error("Error fetching features:", error);
    return NextResponse.json({ error: "Failed to fetch features" }, { status: 500 });
  }
}
