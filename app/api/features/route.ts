import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const features = await sql`
      SELECT id as "_id", name, slug, description, icon, 
             included_in_tiers as "includedInTiers", category
      FROM platform_features
      WHERE status = 'active'
      ORDER BY "order" ASC
    `;

    return NextResponse.json({
      ok: true,
      features
    });
  } catch (error) {
    console.error("Error fetching features:", error);
    return NextResponse.json({ error: "Failed to fetch features" }, { status: 500 });
  }
}
