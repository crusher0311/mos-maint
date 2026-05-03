import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { listPlatformFeatures } from "@/lib/data/repositories/platform-features";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const features = await listPlatformFeatures(
      { status: "active" },
      {
        sort: { order: 1 },
        projection: {
          _id: 1,
          name: 1,
          slug: 1,
          description: 1,
          icon: 1,
          includedInTiers: 1,
          category: 1,
        },
      },
    );

    return NextResponse.json({
      ok: true,
      features,
    });
  } catch (error) {
    console.error("Error fetching features:", error);
    return NextResponse.json({ error: "Failed to fetch features" }, { status: 500 });
  }
}
