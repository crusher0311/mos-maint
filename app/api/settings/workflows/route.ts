import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const shopId = String(sess.shopId);
  const shopResult = await sql`SELECT settings FROM shops WHERE shop_id = ${shopId} LIMIT 1`;
  const settings = (shopResult[0]?.settings as Record<string, unknown>) || {};

  return NextResponse.json({
    workflows: settings.customerWorkflows || [],
  });
}

export async function POST(req: NextRequest) {
  const sess = await getSession();
  if (!sess) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (sess.role !== "owner" && sess.role !== "admin" && sess.role !== "manager") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json();
  const { workflows } = body;

  const shopId = String(sess.shopId);
  const shopResult = await sql`SELECT settings FROM shops WHERE shop_id = ${shopId} LIMIT 1`;
  const existingSettings = (shopResult[0]?.settings as Record<string, unknown>) || {};

  const updatedSettings = {
    ...existingSettings,
    customerWorkflows: workflows
  };

  await sql`
    UPDATE shops SET settings = ${JSON.stringify(updatedSettings)}::jsonb, updated_at = ${new Date()}
    WHERE shop_id = ${shopId}
  `;

  return NextResponse.json({ ok: true });
}
