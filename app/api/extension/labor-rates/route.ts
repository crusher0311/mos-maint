import { NextRequest, NextResponse } from "next/server";
import { validateExtensionToken } from "@/lib/extension-auth";
import { getDb } from "@/lib/mongo";
import { ObjectId } from "mongodb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return NextResponse.json({}, { headers: CORS_HEADERS });
}

export async function GET(req: NextRequest) {
  const auth = await validateExtensionToken(req);
  if (!auth.authorized || !auth.user) {
    return NextResponse.json({ ok: false, error: auth.error || "Unauthorized" }, { status: 401, headers: CORS_HEADERS });
  }

  const db = await getDb();
  const shop = await db.collection("shops").findOne(
    { shopId: auth.user.shopId },
    { projection: { laborRateRules: 1 } }
  );

  return NextResponse.json({ ok: true, rules: shop?.laborRateRules || [] }, { headers: CORS_HEADERS });
}

export async function PUT(req: NextRequest) {
  const auth = await validateExtensionToken(req);
  if (!auth.authorized || !auth.user) {
    return NextResponse.json({ ok: false, error: auth.error || "Unauthorized" }, { status: 401, headers: CORS_HEADERS });
  }

  const body = await req.json();
  const { rules } = body;

  if (!Array.isArray(rules)) {
    return NextResponse.json({ ok: false, error: "Rules array required" }, { status: 400, headers: CORS_HEADERS });
  }

  const sanitized = rules.map((r: any) => ({
    id: r.id || new ObjectId().toHexString(),
    name: r.name || "Untitled Rule",
    rate: Number(r.rate) || 0,
    priority: Number(r.priority) || 0,
    conditions: (r.conditions || []).map((c: any) => ({
      type: c.type,
      field: c.field || null,
      label: c.label || null,
      values: Array.isArray(c.values) ? c.values : [],
    })),
    matchMode: r.matchMode === "any" ? "any" : "all",
    createdAt: r.createdAt ? new Date(r.createdAt) : new Date(),
    updatedAt: new Date(),
  }));

  const db = await getDb();
  await db.collection("shops").updateOne(
    { shopId: auth.user.shopId },
    { $set: { laborRateRules: sanitized } }
  );

  return NextResponse.json({ ok: true, rules: sanitized }, { headers: CORS_HEADERS });
}
