import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { ObjectId } from "mongodb";
import {
  findShopLaborRateRulesById,
  replaceLaborRateRulesForShopIds,
} from "@/lib/data/repositories/shops";
import {
  LaborRateRuleValidationError,
  normalizeLaborRateRule,
  normalizeLaborRateRuleSet,
} from "@/lib/labor-rate-rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const shop = await findShopLaborRateRulesById(Number(session.shopId));

  return NextResponse.json({ rules: shop?.laborRateRules || [] });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  let rule;
  try {
    rule = normalizeLaborRateRule(body, {
      createId: () => new ObjectId().toHexString(),
    });
  } catch (error) {
    if (error instanceof LaborRateRuleValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  const shopId = Number(session.shopId);
  const shop = await findShopLaborRateRulesById(shopId);
  if (!shop) return NextResponse.json({ error: "Current shop not found" }, { status: 404 });
  const rules = normalizeLaborRateRuleSet([...(shop.laborRateRules ?? []), rule]);
  await replaceLaborRateRulesForShopIds([shopId], rules);

  return NextResponse.json({ ok: true, rule });
}

export async function PUT(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  if (Object.prototype.hasOwnProperty.call(body, "rules")) {
    try {
      const rules = normalizeLaborRateRuleSet(body.rules);
      const result = await replaceLaborRateRulesForShopIds(
        [Number(session.shopId)],
        rules,
      );
      if ((result.matchedCount ?? 0) !== 1) {
        return NextResponse.json(
          { error: "Current shop not found", matchedCount: result.matchedCount ?? 0, updatedCount: 0 },
          { status: 404 },
        );
      }
      return NextResponse.json({
        ok: true,
        rules,
        matchedCount: result.matchedCount,
        updatedCount: result.modifiedCount ?? 0,
      });
    } catch (error) {
      if (error instanceof LaborRateRuleValidationError) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      throw error;
    }
  }
  const { id, name, rate, priority, conditions, matchMode, overrideCategoryRates } = body;

  if (!id) return NextResponse.json({ error: "Rule ID required" }, { status: 400 });

  let normalized;
  try {
    normalized = normalizeLaborRateRule({
      id,
      name,
      rate,
      priority,
      conditions,
      matchMode,
      overrideCategoryRates,
    });
  } catch (error) {
    if (error instanceof LaborRateRuleValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  const shopId = Number(session.shopId);
  const shop = await findShopLaborRateRulesById(shopId);
  if (!shop) return NextResponse.json({ error: "Current shop not found" }, { status: 404 });
  const rules = normalizeLaborRateRuleSet(shop.laborRateRules ?? []);
  const index = rules.findIndex((rule) => rule.id === id);
  if (index < 0) return NextResponse.json({ error: "Rule not found" }, { status: 404 });
  rules[index] = {
    ...normalized,
    ...(rules[index].color ? { color: rules[index].color } : {}),
    ...(rules[index].applyToAllLabor !== undefined
      ? { applyToAllLabor: rules[index].applyToAllLabor }
      : {}),
    createdAt: rules[index].createdAt,
    updatedAt: new Date(),
  };
  await replaceLaborRateRulesForShopIds([shopId], rules);

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Rule ID required" }, { status: 400 });

  const shopId = Number(session.shopId);
  const shop = await findShopLaborRateRulesById(shopId);
  if (!shop) return NextResponse.json({ error: "Current shop not found" }, { status: 404 });
  const rules = normalizeLaborRateRuleSet(shop.laborRateRules ?? []);
  const next = rules.filter((rule) => rule.id !== id);
  if (next.length === rules.length) {
    return NextResponse.json({ error: "Rule not found" }, { status: 404 });
  }
  await replaceLaborRateRulesForShopIds([shopId], next);

  return NextResponse.json({ ok: true });
}
