import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";
import crypto from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (sess.role !== "owner" && sess.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const apiKey = `mos_ext_${crypto.randomBytes(24).toString("hex")}`;
  const shopId = String(sess.shopId);

  const shopResult = await sql`SELECT settings FROM shops WHERE shop_id = ${shopId} LIMIT 1`;
  const existingSettings = (shopResult[0]?.settings as Record<string, unknown>) || {};
  const extensions = (existingSettings.extensions as Record<string, unknown>) || {};
  const apiKeys = (extensions.apiKeys as Array<{ key: string; createdAt: string }>) || [];
  
  apiKeys.push({ key: apiKey, createdAt: new Date().toISOString() });
  
  const updatedSettings = {
    ...existingSettings,
    extensions: { ...extensions, apiKeys }
  };

  await sql`
    UPDATE shops SET settings = ${JSON.stringify(updatedSettings)}::jsonb, updated_at = ${new Date()}
    WHERE shop_id = ${shopId}
  `;

  return NextResponse.json({ key: apiKey });
}
