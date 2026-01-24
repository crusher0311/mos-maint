import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session?.isPlatformAdmin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const db = await getDb();
  
  const invites = await db.collection("setup_tokens").aggregate([
    {
      $lookup: {
        from: "shops",
        localField: "shopId",
        foreignField: "shopId",
        as: "shopInfo"
      }
    },
    {
      $project: {
        _id: 1,
        token: 1,
        shopId: 1,
        emailLower: 1,
        role: 1,
        createdAt: 1,
        expiresAt: 1,
        shopName: { $arrayElemAt: ["$shopInfo.name", 0] }
      }
    },
    {
      $sort: { createdAt: -1 }
    }
  ]).toArray();

  return NextResponse.json({ ok: true, invites });
}
