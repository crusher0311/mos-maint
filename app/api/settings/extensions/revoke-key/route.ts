import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (sess.role !== "owner" && sess.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const { keyId } = body;

  if (!keyId) {
    return NextResponse.json({ error: "Key ID is required" }, { status: 400 });
  }

  const db = await getDb();
  const shop = await db.collection("shops").findOne({ shopId: sess.shopId });
  const matchingKey = (shop?.extensions?.apiKeys || []).find(
    (k: any) => k.key.startsWith(keyId)
  );

  if (!matchingKey) {
    return NextResponse.json({ error: "Key not found" }, { status: 404 });
  }

  await db.collection("shops").updateOne(
    { shopId: sess.shopId },
    {
      $pull: { "extensions.apiKeys": { key: matchingKey.key } } as any,
      $set: { updatedAt: new Date() },
    }
  );

  return NextResponse.json({ ok: true });
}
