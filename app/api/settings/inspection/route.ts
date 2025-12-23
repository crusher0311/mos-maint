import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = await getDb();
  const shop = await db.collection("shops").findOne({ shopId: sess.shopId });

  return NextResponse.json({
    items: shop?.inspectionMappings || [],
  });
}

export async function POST(req: NextRequest) {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (sess.role !== "owner" && sess.role !== "admin" && sess.role !== "manager") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const { items } = body;

  const db = await getDb();
  await db.collection("shops").updateOne(
    { shopId: sess.shopId },
    { $set: { inspectionMappings: items, updatedAt: new Date() } }
  );

  return NextResponse.json({ ok: true });
}
