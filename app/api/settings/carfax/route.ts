import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";

export async function GET() {
  try {
    const session = await requireSession();
    const shopId = String(session.shopId);

    const shopResult = await sql`
      SELECT settings FROM shops WHERE shop_id = ${shopId} LIMIT 1
    `;
    const settings = (shopResult[0]?.settings as Record<string, unknown>) || {};
    const carfax = (settings.carfax as Record<string, unknown>) || {};

    const hasUrl = Boolean(process.env.CARFAX_POST_URL);
    const hasPdi = Boolean(process.env.CARFAX_PDI);

    return NextResponse.json({
      locationId: carfax.locationId || "",
      envConfigured: hasUrl && hasPdi,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message || "Unexpected error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const session = await requireSession();
    const shopId = String(session.shopId);
    const body = await req.json();
    const { locationId } = body || {};

    const shopResult = await sql`SELECT settings FROM shops WHERE shop_id = ${shopId} LIMIT 1`;
    const existingSettings = (shopResult[0]?.settings as Record<string, unknown>) || {};

    const updatedSettings = {
      ...existingSettings,
      carfax: { locationId: String(locationId || "").trim() }
    };

    await sql`
      UPDATE shops SET settings = ${JSON.stringify(updatedSettings)}::jsonb, updated_at = ${new Date()}
      WHERE shop_id = ${shopId}
    `;

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message || "Unexpected error" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const session = await requireSession();
    const shopId = String(session.shopId);

    const shopResult = await sql`SELECT settings FROM shops WHERE shop_id = ${shopId} LIMIT 1`;
    const existingSettings = (shopResult[0]?.settings as Record<string, unknown>) || {};
    const updatedSettings = { ...existingSettings };
    delete updatedSettings.carfax;

    await sql`
      UPDATE shops SET settings = ${JSON.stringify(updatedSettings)}::jsonb, updated_at = ${new Date()}
      WHERE shop_id = ${shopId}
    `;

    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message || "Unexpected error" }, { status: 500 });
  }
}
