import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (sess.role !== "owner" && sess.role !== "admin") {
    return NextResponse.json({ error: "Forbidden - only owners can view extension settings" }, { status: 403 });
  }

  const db = await getDb();
  const shop = await db.collection("shops").findOne({ shopId: sess.shopId });

  const extensions = shop?.extensions || { enabled: false, apiKeys: [] };

  return NextResponse.json({
    enabled: extensions.enabled || false,
    apiKeys: (extensions.apiKeys || []).map((k: any) => ({
      key: `${k.key.substring(0, 12)}...${k.key.substring(k.key.length - 4)}`,
      keyId: k.key.substring(0, 20),
      createdAt: k.createdAt,
      lastUsed: k.lastUsed,
    })),
  });
}

export async function POST(req: NextRequest) {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (sess.role !== "owner" && sess.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const { enabled } = body;

  const db = await getDb();
  await db.collection("shops").updateOne(
    { shopId: sess.shopId },
    { $set: { "extensions.enabled": enabled, updatedAt: new Date() } }
  );

  return NextResponse.json({ ok: true });
}
