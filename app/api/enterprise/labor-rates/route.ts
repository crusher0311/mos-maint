import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getEnterpriseByShopId } from "@/lib/enterprise";
import {
  listShopLaborRateRulesByIds,
  replaceLaborRateRulesForShopIds,
} from "@/lib/data/repositories/shops";
import {
  LaborRateRuleValidationError,
  canManageEnterpriseLaborRates,
  laborRateRuleSetsEqual,
  normalizeLaborRateRuleSet,
} from "@/lib/labor-rate-rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function context() {
  const session = await getSession();
  if (!session) return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!canManageEnterpriseLaborRates(session)) {
    return { response: NextResponse.json({ error: "Permission denied" }, { status: 403 }) };
  }
  const shopId = Number(session.shopId);
  if (!Number.isFinite(shopId)) {
    return { response: NextResponse.json({ error: "Session shop is invalid" }, { status: 400 }) };
  }
  const enterprise = await getEnterpriseByShopId(shopId);
  if (!enterprise || !enterprise.shopIds.map(Number).includes(shopId)) {
    return { response: NextResponse.json({ error: "Not part of an enterprise" }, { status: 400 }) };
  }
  return { session, shopId, enterprise };
}

export async function GET() {
  const ctx = await context();
  if ("response" in ctx) return ctx.response;
  const shopIds = [...new Set(ctx.enterprise.shopIds.map(Number).filter(Number.isFinite))];
  const shops = await listShopLaborRateRulesByIds(shopIds);
  if (shops.length !== shopIds.length) {
    return NextResponse.json(
      { error: "One or more enterprise locations could not be found", expectedCount: shopIds.length, matchedCount: shops.length },
      { status: 409 },
    );
  }

  try {
    const locations = shops.map((shop) => ({
      shopId: Number(shop.shopId),
      name: shop.name || `Shop ${shop.shopId}`,
      locationIdentifier: shop.locationIdentifier || null,
      rules: normalizeLaborRateRuleSet(shop.laborRateRules ?? []),
    }));
    const representative =
      locations.find((location) => location.shopId === ctx.shopId) || locations[0];
    const differences = locations
      .filter((location) => !laborRateRuleSetsEqual(location.rules, representative?.rules || []))
      .map((location) => location.shopId);
    return NextResponse.json({
      ok: true,
      enterprise: {
        id: String(ctx.enterprise._id || ""),
        name: ctx.enterprise.name,
      },
      enterpriseId: String(ctx.enterprise._id || ""),
      enterpriseName: ctx.enterprise.name,
      representativeShopId: representative?.shopId ?? null,
      rules: representative?.rules || [],
      locationCount: locations.length,
      locations: locations.map(({ rules, ...location }) => ({
        ...location,
        ruleCount: rules.length,
      })),
      consistent: differences.length === 0,
      differingLocationCount: differences.length,
      differingShopIds: differences,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid labor-rate rules";
    return NextResponse.json({ error: message }, { status: 409 });
  }
}

async function replaceAll(req: NextRequest) {
  const ctx = await context();
  if ("response" in ctx) return ctx.response;
  try {
    const body = await req.json();
    const rules = normalizeLaborRateRuleSet(body.rules);
    const shopIds = [...new Set(ctx.enterprise.shopIds.map(Number).filter(Number.isFinite))];
    const existing = await listShopLaborRateRulesByIds(shopIds);
    if (existing.length !== shopIds.length) {
      return NextResponse.json(
        { error: "Cannot update: one or more enterprise locations were not found", expectedCount: shopIds.length, matchedCount: existing.length, updatedCount: 0 },
        { status: 409 },
      );
    }
    const result = await replaceLaborRateRulesForShopIds(shopIds, rules);
    const matchedCount = result.matchedCount ?? 0;
    const updatedCount = result.modifiedCount ?? 0;
    if (matchedCount !== shopIds.length) {
      return NextResponse.json(
        { error: "Not every enterprise location was updated", expectedCount: shopIds.length, matchedCount, updatedCount },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true, rules, locationCount: shopIds.length, matchedCount, updatedCount });
  } catch (error) {
    if (error instanceof LaborRateRuleValidationError || error instanceof SyntaxError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}

export const PUT = replaceAll;
export const POST = replaceAll;