import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (sess.role !== "owner" && sess.role !== "admin") {
    return NextResponse.json({ error: "Forbidden - only owners can view extension settings" }, { status: 403 });
  }

  const shopId = String(sess.shopId);
  const shopResult = await sql`SELECT settings FROM shops WHERE shop_id = ${shopId} LIMIT 1`;
  const settings = (shopResult[0]?.settings as Record<string, unknown>) || {};
  const extensions = (settings.extensions as Record<string, unknown>) || { enabled: false, apiKeys: [] };
  const apiKeys = (extensions.apiKeys as Array<{ key: string; createdAt: string; lastUsed?: string }>) || [];

  return NextResponse.json({
    enabled: extensions.enabled || false,
    apiKeys: apiKeys.map((k) => ({
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

  const shopId = String(sess.shopId);
  const shopResult = await sql`SELECT settings FROM shops WHERE shop_id = ${shopId} LIMIT 1`;
  const existingSettings = (shopResult[0]?.settings as Record<string, unknown>) || {};
  const extensions = (existingSettings.extensions as Record<string, unknown>) || {};
  
  const updatedSettings = {
    ...existingSettings,
    extensions: { ...extensions, enabled }
  };

  await sql`
    UPDATE shops SET settings = ${JSON.stringify(updatedSettings)}::jsonb, updated_at = ${new Date()}
    WHERE shop_id = ${shopId}
  `;

  return NextResponse.json({ ok: true });
}
