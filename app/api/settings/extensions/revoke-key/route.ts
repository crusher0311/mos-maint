import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

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

  const shopId = String(sess.shopId);
  const shopResult = await sql`SELECT settings FROM shops WHERE shop_id = ${shopId} LIMIT 1`;
  const existingSettings = (shopResult[0]?.settings as Record<string, unknown>) || {};
  const extensions = (existingSettings.extensions as Record<string, unknown>) || {};
  const apiKeys = (extensions.apiKeys as Array<{ key: string; createdAt: string }>) || [];
  
  const matchingKey = apiKeys.find((k) => k.key.startsWith(keyId));

  if (!matchingKey) {
    return NextResponse.json({ error: "Key not found" }, { status: 404 });
  }

  const updatedApiKeys = apiKeys.filter((k) => k.key !== matchingKey.key);
  
  const updatedSettings = {
    ...existingSettings,
    extensions: { ...extensions, apiKeys: updatedApiKeys }
  };

  await sql`
    UPDATE shops SET settings = ${JSON.stringify(updatedSettings)}::jsonb, updated_at = ${new Date()}
    WHERE shop_id = ${shopId}
  `;

  return NextResponse.json({ ok: true });
}
