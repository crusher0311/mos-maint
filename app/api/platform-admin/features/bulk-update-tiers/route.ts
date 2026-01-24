import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { ObjectId } from "mongodb";

export const runtime = "nodejs";

const VALID_TIERS = ["starter", "plus", "elite", "enterprise"];

function isValidObjectId(id: string): boolean {
  try {
    new ObjectId(id);
    return true;
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  const sess = await getSession();
  if (!sess) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (sess.role !== "platform_admin") {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  try {
    const { updates } = await req.json();

    if (!Array.isArray(updates)) {
      return NextResponse.json({ error: "Invalid updates format" }, { status: 400 });
    }

    const db = await getDb();
    const collection = db.collection("platform_features");

    const validUpdates = updates.filter((update: { id: string; includedInTiers: string[] }) => {
      if (!update.id || !isValidObjectId(update.id)) {
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

    const bulkOps = validUpdates.map((update: { id: string; includedInTiers: string[] }) => ({
      updateOne: {
        filter: { _id: new ObjectId(update.id) },
        update: { $set: { includedInTiers: update.includedInTiers } },
      },
    }));

    const result = await collection.bulkWrite(bulkOps);

    return NextResponse.json({ 
      ok: true, 
      message: "Features updated successfully",
      modified: result.modifiedCount
    });
  } catch (err) {
    console.error("Error bulk updating feature tiers:", err);
    return NextResponse.json({ error: "Failed to update features" }, { status: 500 });
  }
}
