import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";

const SUPER_ADMINS = ["brandoncrusha@gmail.com", "brandoncrusha+1@gmail.com"];
const VALID_TIERS = ["starter", "plus", "elite", "enterprise"];

export async function POST(req: NextRequest) {
  const sess = await getSession();
  if (!sess) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!SUPER_ADMINS.includes(sess.email)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  try {
    const { updates } = await req.json();

    if (!Array.isArray(updates)) {
      return NextResponse.json({ error: "Invalid updates format" }, { status: 400 });
    }

    const validUpdates = updates.filter((update: { id: string | number; includedInTiers: string[] }) => {
      const numId = Number(update.id);
      if (isNaN(numId)) {
        return false;
      }
      if (!Array.isArray(update.includedInTiers)) {
        return false;
      }
      const validTiers = update.includedInTiers.filter((t: string) => VALID_TIERS.includes(t));
      update.includedInTiers = validTiers;
      return true;
    });

    if (validUpdates.length === 0) {
      return NextResponse.json({ error: "No valid updates provided" }, { status: 400 });
    }

    let modifiedCount = 0;
    for (const update of validUpdates) {
      const numId = Number(update.id);
      const result = await sql`
        UPDATE platform_features 
        SET included_in_tiers = ${JSON.stringify(update.includedInTiers)}, updated_at = NOW()
        WHERE id = ${numId}
      `;
      modifiedCount += result.count;
    }

    return NextResponse.json({ 
      ok: true, 
      message: "Features updated successfully",
      modified: modifiedCount
    });
  } catch (err) {
    console.error("Error bulk updating feature tiers:", err);
    return NextResponse.json({ error: "Failed to update features" }, { status: 500 });
  }
}
