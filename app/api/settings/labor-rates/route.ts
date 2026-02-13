import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { ObjectId } from "mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = await getDb();
  const shop = await db.collection("shops").findOne(
    { shopId: Number(session.shopId) },
    { projection: { laborRateRules: 1 } }
  );

  return NextResponse.json({ rules: shop?.laborRateRules || [] });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { name, rate, priority, conditions, matchMode } = body;

  if (!name || rate == null || !Array.isArray(conditions)) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const rule = {
    id: new ObjectId().toHexString(),
    name,
    rate: Number(rate),
    priority: Number(priority) || 0,
    conditions: conditions.map((c: any) => ({
      type: c.type,
      label: c.label || null,
      values: Array.isArray(c.values) ? c.values : [],
    })),
    matchMode: matchMode === "any" ? "any" : "all",
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const db = await getDb();
  await db.collection("shops").updateOne(
    { shopId: Number(session.shopId) },
    { $push: { laborRateRules: rule } as any }
  );

  return NextResponse.json({ ok: true, rule });
}

export async function PUT(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { id, name, rate, priority, conditions, matchMode } = body;

  if (!id) return NextResponse.json({ error: "Rule ID required" }, { status: 400 });

  const safeConditions = Array.isArray(conditions) ? conditions : [];

  const db = await getDb();
  await db.collection("shops").updateOne(
    { shopId: Number(session.shopId), "laborRateRules.id": id },
    {
      $set: {
        "laborRateRules.$.name": name,
        "laborRateRules.$.rate": Number(rate) || 0,
        "laborRateRules.$.priority": Number(priority) || 0,
        "laborRateRules.$.conditions": safeConditions.map((c: any) => ({
          type: c.type,
          label: c.label || null,
          values: Array.isArray(c.values) ? c.values : [],
        })),
        "laborRateRules.$.matchMode": matchMode === "any" ? "any" : "all",
        "laborRateRules.$.updatedAt": new Date(),
      },
    }
  );

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Rule ID required" }, { status: 400 });

  const db = await getDb();
  await db.collection("shops").updateOne(
    { shopId: Number(session.shopId) },
    { $pull: { laborRateRules: { id } } as any }
  );

  return NextResponse.json({ ok: true });
}
