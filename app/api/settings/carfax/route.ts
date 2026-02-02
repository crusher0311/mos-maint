import { NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { requireSession } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET() {
  try {
    const session = await requireSession();
    const shopId = Number(session.shopId);

    const db = await getDb();
    const shop = await db.collection("shops").findOne(
      { shopId },
      { projection: { carfax: 1, carfaxLocationId: 1 } }
    );

    const hasUrl = Boolean(process.env.CARFAX_POST_URL);
    const hasPdi = Boolean(process.env.CARFAX_PDI);

    return NextResponse.json({
      locationId: shop?.carfax?.locationId || shop?.carfaxLocationId || "",
      envConfigured: hasUrl && hasPdi,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Unexpected error" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const session = await requireSession();
    const shopId = Number(session.shopId);
    const body = await req.json();
    const { locationId } = body || {};

    const db = await getDb();
    await db.collection("shops").updateOne(
      { shopId },
      {
        $set: {
          carfax: { locationId: String(locationId || "").trim() },
          carfaxLocationId: String(locationId || "").trim(),
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Unexpected error" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const session = await requireSession();
    const shopId = Number(session.shopId);

    const db = await getDb();
    await db.collection("shops").updateOne(
      { shopId },
      {
        $unset: {
          carfax: "",
          carfaxLocationId: "",
        },
        $set: { updatedAt: new Date() },
      }
    );

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Unexpected error" }, { status: 500 });
  }
}
