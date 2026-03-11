import { NextRequest, NextResponse } from "next/server";
import { validateExtensionToken, getAuthErrorStatus, getUserShopIds } from "@/lib/extension-auth";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";
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
    return NextResponse.json({ ok: false, error: auth.error || "Unauthorized" }, { status: getAuthErrorStatus(auth), headers: CORS_HEADERS });
  }

  const db = await getDb();
  const { searchParams } = new URL(req.url);
  const smsShopId = searchParams.get("smsShopId") || searchParams.get("shopId");

  const userShopIds = getUserShopIds(auth.user).map(id => parseInt(id));
  const isPlatformAdmin = auth.user.role === "platform_admin";

  let shop;
  if (smsShopId) {
    const provider = searchParams.get("provider") || undefined;
    const shopResult = await findShopBySmsId(smsShopId, { userShopIds, isPlatformAdmin, providerHint: provider });
    if (!shopResult) {
      return NextResponse.json({ ok: false, error: `No accessible shop configured for SMS shop ID ${smsShopId}` }, { status: 404, headers: CORS_HEADERS });
    }
    shop = await db.collection("shops").findOne(
      { shopId: shopResult.mosShopId },
      { projection: { laborRateRules: 1, shopId: 1 } }
    );
  } else {
    shop = await db.collection("shops").findOne(
      { shopId: auth.user.shopId },
      { projection: { laborRateRules: 1, shopId: 1 } }
    );
  }

  return NextResponse.json({ ok: true, rules: shop?.laborRateRules || [], shopId: shop?.shopId }, { headers: CORS_HEADERS });
}

export async function PUT(req: NextRequest) {
  const auth = await validateExtensionToken(req);
  if (!auth.authorized || !auth.user) {
    return NextResponse.json({ ok: false, error: auth.error || "Unauthorized" }, { status: getAuthErrorStatus(auth), headers: CORS_HEADERS });
  }

  const body = await req.json();
  const { rules } = body;

  if (!Array.isArray(rules)) {
    return NextResponse.json({ ok: false, error: "Rules array required" }, { status: 400, headers: CORS_HEADERS });
  }

  const validColors = ['#3B82F6','#10B981','#F59E0B','#EF4444','#8B5CF6','#EC4899','#6B7280'];
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
    color: validColors.includes(r.color) ? r.color : '#3B82F6',
    applyToAllLabor: Boolean(r.applyToAllLabor),
    overrideCategoryRates: Boolean(r.overrideCategoryRates),
    createdAt: r.createdAt ? new Date(r.createdAt) : new Date(),
    updatedAt: new Date(),
  }));

  const db = await getDb();
  const { searchParams } = new URL(req.url);
  const smsShopId = searchParams.get("smsShopId") || searchParams.get("shopId");

  const userShopIds = getUserShopIds(auth.user).map(id => parseInt(id));
  const isPlatformAdmin = auth.user.role === "platform_admin";

  let targetShopId = auth.user.shopId;

  if (smsShopId) {
    const provider = searchParams.get("provider") || undefined;
    const shopResult = await findShopBySmsId(smsShopId, { userShopIds, isPlatformAdmin, providerHint: provider });
    if (!shopResult) {
      return NextResponse.json({ ok: false, error: `No accessible shop configured for SMS shop ID ${smsShopId}` }, { status: 404, headers: CORS_HEADERS });
    }
    targetShopId = shopResult.mosShopId;
  }

  await db.collection("shops").updateOne(
    { shopId: targetShopId },
    { $set: { laborRateRules: sanitized } }
  );

  return NextResponse.json({ ok: true, rules: sanitized, shopId: targetShopId }, { headers: CORS_HEADERS });
}
