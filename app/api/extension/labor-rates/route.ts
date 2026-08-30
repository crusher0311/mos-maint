import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import { validateExtensionToken, getAuthErrorStatus, getUserShopIds, buildAuthErrorBody, requireExtensionPrincipalScope } from "@/lib/extension-auth";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";
import { checkShopFeatureGate } from "@/lib/extension-route-guard";
import {
  findShopLaborRateRulesById,
  replaceLaborRateRulesForShopIdIfRevision,
  replaceLaborRateRulesForShopIds,
} from "@/lib/data/repositories/shops";
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

async function _GET(req: NextRequest) {
  const auth = await validateExtensionToken(req);
  if (!auth.authorized || !auth.user) {
    return NextResponse.json(buildAuthErrorBody(auth, { ok: false }), { status: getAuthErrorStatus(auth), headers: CORS_HEADERS });
  }

  const { searchParams } = new URL(req.url);
  const smsShopId = searchParams.get("smsShopId") || searchParams.get("shopId");

  const userShopIds = getUserShopIds(auth.user).map(id => parseInt(id));
  const isPlatformAdmin = auth.user.role === "platform_admin";

  let resolvedShopId: number;
  if (smsShopId) {
    const provider = searchParams.get("provider") || undefined;
    const shopResult = await findShopBySmsId(smsShopId, { userShopIds, isPlatformAdmin, providerHint: provider });
    if (!shopResult) {
      return NextResponse.json({ ok: false, error: `No accessible shop configured for SMS shop ID ${smsShopId}` }, { status: 404, headers: CORS_HEADERS });
    }
    const scopeFailure = requireExtensionPrincipalScope(auth, {
      shopId: shopResult.mosShopId,
      provider: provider || shopResult.provider,
    });
    if (scopeFailure) {
      return NextResponse.json(
        buildAuthErrorBody(scopeFailure, { ok: false }),
        { status: getAuthErrorStatus(scopeFailure), headers: CORS_HEADERS }
      );
    }
    resolvedShopId = shopResult.mosShopId;
  } else if (userShopIds.length <= 1) {
    resolvedShopId = auth.user.shopId;
  } else {
    return NextResponse.json(
      { ok: false, error: "shopId or smsShopId is required for multi-shop users" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const denied = await checkShopFeatureGate(resolvedShopId, ["maintenance"], {
    isPlatformAdmin,
    featureLabel: "Labor Rates",
    corsHeaders: CORS_HEADERS,
  });
  if (denied) return denied;

  const shop = await findShopLaborRateRulesById(resolvedShopId);

  return NextResponse.json({
    ok: true,
    rules: shop?.laborRateRules || [],
    shopId: shop?.shopId,
    revision: Number(shop?.laborRateRulesRevision ?? 0),
  }, { headers: CORS_HEADERS });
}

async function _PUT(req: NextRequest) {
  const auth = await validateExtensionToken(req);
  if (!auth.authorized || !auth.user) {
    return NextResponse.json(buildAuthErrorBody(auth, { ok: false }), { status: getAuthErrorStatus(auth), headers: CORS_HEADERS });
  }

  const body = await req.json();
  const { rules } = body;
  const hasExpectedRevision = Object.prototype.hasOwnProperty.call(body, "expectedRevision");
  const expectedRevision = hasExpectedRevision ? Number(body.expectedRevision) : null;

  if (!Array.isArray(rules)) {
    return NextResponse.json({ ok: false, error: "Rules array required" }, { status: 400, headers: CORS_HEADERS });
  }
  if (hasExpectedRevision && (!Number.isInteger(expectedRevision) || Number(expectedRevision) < 0)) {
    return NextResponse.json({ ok: false, error: "Valid expectedRevision required" }, { status: 400, headers: CORS_HEADERS });
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

  const { searchParams } = new URL(req.url);
  const smsShopId = searchParams.get("smsShopId") || searchParams.get("shopId");

  const userShopIds = getUserShopIds(auth.user).map(id => parseInt(id));
  const isPlatformAdmin = auth.user.role === "platform_admin";

  let targetShopId: number;

  if (smsShopId) {
    const provider = searchParams.get("provider") || undefined;
    const shopResult = await findShopBySmsId(smsShopId, { userShopIds, isPlatformAdmin, providerHint: provider });
    if (!shopResult) {
      return NextResponse.json({ ok: false, error: `No accessible shop configured for SMS shop ID ${smsShopId}` }, { status: 404, headers: CORS_HEADERS });
    }
    const scopeFailurePut = requireExtensionPrincipalScope(auth, {
      shopId: shopResult.mosShopId,
      provider: provider || shopResult.provider,
    });
    if (scopeFailurePut) {
      return NextResponse.json(
        buildAuthErrorBody(scopeFailurePut, { ok: false }),
        { status: getAuthErrorStatus(scopeFailurePut), headers: CORS_HEADERS }
      );
    }
    targetShopId = shopResult.mosShopId;
  } else if (userShopIds.length <= 1) {
    targetShopId = auth.user.shopId;
  } else {
    return NextResponse.json(
      { ok: false, error: "shopId or smsShopId is required for multi-shop users to prevent cross-shop rule contamination" },
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const denied = await checkShopFeatureGate(targetShopId, ["maintenance"], {
    isPlatformAdmin,
    featureLabel: "Labor Rates",
    corsHeaders: CORS_HEADERS,
  });
  if (denied) return denied;

  const existingShop = await findShopLaborRateRulesById(targetShopId);
  if (!existingShop) {
    return NextResponse.json({ ok: false, error: "Target shop not found" }, { status: 404, headers: CORS_HEADERS });
  }

  const result: { matchedCount: number; modifiedCount: number; revision?: number } = hasExpectedRevision
    ? await replaceLaborRateRulesForShopIdIfRevision(
        targetShopId,
        sanitized,
        Number(expectedRevision),
      )
    : await replaceLaborRateRulesForShopIds([targetShopId], sanitized);
  if (result.matchedCount !== 1) {
    if (hasExpectedRevision) {
      const current = await findShopLaborRateRulesById(targetShopId);
      return NextResponse.json({
        ok: false,
        code: "LABOR_RATE_RULES_STALE",
        error: "Labor-rate rules changed since this extension loaded them. Reload the latest rules before saving.",
        revision: Number(current?.laborRateRulesRevision ?? 0),
      }, { status: 409, headers: CORS_HEADERS });
    }
    return NextResponse.json({ ok: false, error: "Target shop not found" }, { status: 404, headers: CORS_HEADERS });
  }

  console.log(`[Extension Labor Rates] Saved ${sanitized.length} rules to shop ${targetShopId} (${existingShop.name || existingShop.shopName}) by ${auth.user.email}`);

  return NextResponse.json({
    ok: true,
    rules: sanitized,
    shopId: targetShopId,
    revision: result.revision ?? Number(existingShop.laborRateRulesRevision ?? 0) + 1,
  }, { headers: CORS_HEADERS });
}

// Task #510: per-shop error-rate alerting — wrap all extension handlers
export const GET = withExtensionErrorMarker(_GET as any);
export const PUT = withExtensionErrorMarker(_PUT as any);
