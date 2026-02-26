import { NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export async function GET() {
  try {
    await requirePlatformAdmin();
    const db = await getDb();

    const names = await db.collection("carfax_cache").aggregate([
      { $unwind: "$serviceRecords" },
      { $group: { _id: "$serviceRecords.description" } },
      { $match: { _id: { $ne: null, $ne: "" } } },
      { $sort: { _id: 1 } }
    ]).toArray();

    return NextResponse.json({ 
      ok: true, 
      names: names.map((n: any) => n._id).filter(Boolean)
    });
  } catch (error: any) {
    if (error.message?.includes("Unauthorized")) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    console.error("[Service Mappings] Error fetching CARFAX names:", error.message);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
