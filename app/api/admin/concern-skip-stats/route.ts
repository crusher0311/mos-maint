import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { requirePlatformAdmin } from "@/lib/auth";
import {
  SKIP_STATS_COLLECTION,
  MIN_ASKED_FOR_HIGH_SKIP,
  normalizeQuestion,
} from "@/lib/concernSkipLearning";

type StatRow = {
  scope: "shop" | "global";
  shopId: string | null;
  symptomCategory: string;
  normalizedQuestion: string;
  question: string;
  asked: number;
  skipped: number;
  answered: number;
  skipRate: number;
  lastUpdated: string | null;
};

function rowFromDoc(d: any): StatRow {
  const asked = Number(d.asked || 0);
  const skipped = Number(d.skipped || 0);
  const answered = Number(d.answered || 0);
  const shopId = d.shopId == null ? null : String(d.shopId);
  return {
    scope: shopId == null ? "global" : "shop",
    shopId,
    symptomCategory: String(d.symptomCategory || "GENERAL"),
    normalizedQuestion: String(d.normalizedQuestion || ""),
    question: String(d.lastSampleText || d.normalizedQuestion || ""),
    asked,
    skipped,
    answered,
    skipRate: asked > 0 ? skipped / asked : 0,
    lastUpdated: d.lastUpdated ? new Date(d.lastUpdated).toISOString() : null,
  };
}

export async function GET(request: NextRequest) {
  try {
    await requirePlatformAdmin();

    const url = new URL(request.url);
    const shopIdParam = url.searchParams.get("shopId");
    const minAsked = Number(url.searchParams.get("minAsked") ?? MIN_ASKED_FOR_HIGH_SKIP);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 1000);

    const db = await getDb();
    const col = db.collection(SKIP_STATS_COLLECTION);

    const shopFilter =
      shopIdParam && shopIdParam !== "global"
        ? { shopId: String(shopIdParam) }
        : null;

    const [shopDocs, globalDocs] = await Promise.all([
      shopFilter ? col.find(shopFilter).toArray() : Promise.resolve([] as any[]),
      col.find({ shopId: null }).toArray(),
    ]);

    const shopRows = shopDocs
      .map(rowFromDoc)
      .filter((r) => r.asked >= minAsked)
      .sort((a, b) => b.skipRate - a.skipRate || b.skipped - a.skipped)
      .slice(0, limit);

    const globalRows = globalDocs
      .map(rowFromDoc)
      .filter((r) => r.asked >= minAsked)
      .sort((a, b) => b.skipRate - a.skipRate || b.skipped - a.skipped)
      .slice(0, limit);

    const groupByCategory = (rows: StatRow[]) => {
      const map = new Map<string, StatRow[]>();
      for (const r of rows) {
        const key = r.symptomCategory;
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(r);
      }
      return Array.from(map.entries())
        .map(([category, items]) => {
          const totalAsked = items.reduce((s, x) => s + x.asked, 0);
          const totalSkipped = items.reduce((s, x) => s + x.skipped, 0);
          return {
            category,
            totalAsked,
            totalSkipped,
            skipRate: totalAsked > 0 ? totalSkipped / totalAsked : 0,
            items,
          };
        })
        .sort((a, b) => b.totalSkipped - a.totalSkipped);
    };

    const knownShopIds = Array.from(
      new Set(
        (await col.distinct("shopId"))
          .filter((s: any) => s != null)
          .map((s: any) => String(s)),
      ),
    ).sort();

    return NextResponse.json({
      ok: true,
      minAsked,
      shopId: shopFilter ? String(shopIdParam) : null,
      knownShopIds,
      shop: groupByCategory(shopRows),
      global: groupByCategory(globalRows),
    });
  } catch (error: any) {
    if (error?.digest === "NEXT_REDIRECT") throw error;
    console.error("[Admin Concern Skip Stats] GET error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to load stats" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    await requirePlatformAdmin();
    const body = await request.json();
    const { action } = body;

    if (action !== "reset") {
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }

    const symptomCategory = String(body.symptomCategory || "").trim();
    const question = String(body.question || "").trim();
    if (!symptomCategory || !question) {
      return NextResponse.json(
        { error: "symptomCategory and question are required" },
        { status: 400 },
      );
    }
    const normalized = normalizeQuestion(question);
    if (!normalized) {
      return NextResponse.json(
        { error: "Could not normalize question" },
        { status: 400 },
      );
    }

    // shopId: explicit null/"global" -> only global; explicit string -> only that shop;
    // omitted -> clear both global and per-shop entries for the question.
    const hasShopId = Object.prototype.hasOwnProperty.call(body, "shopId");
    const shopIdRaw = body.shopId;
    const filter: any = { symptomCategory, normalizedQuestion: normalized };
    if (hasShopId) {
      filter.shopId =
        shopIdRaw == null || shopIdRaw === "global" ? null : String(shopIdRaw);
    }

    const db = await getDb();
    const result = await db.collection(SKIP_STATS_COLLECTION).deleteMany(filter);

    return NextResponse.json({
      ok: true,
      deletedCount: result.deletedCount ?? 0,
    });
  } catch (error: any) {
    if (error?.digest === "NEXT_REDIRECT") throw error;
    console.error("[Admin Concern Skip Stats] POST error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to reset stats" },
      { status: 500 },
    );
  }
}
