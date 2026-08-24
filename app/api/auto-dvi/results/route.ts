// Task #991 — Auto DVI results (dashboard session): load/save per-item
// technician findings (green/yellow/red rating, notes, recommendation).
// Media refs ride along on GET; uploads go through /api/auto-dvi/media.

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { checkShopFeatureGate } from "@/lib/extension-route-guard";
import {
  readInspectionResults,
  saveInspectionResults,
  type InspectionRating,
} from "@/lib/data/repositories/auto-dvi";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ITEMS = 200;
const MAX_TEXT = 1000;

async function gate() {
  const session = await getSession();
  if (!session) return { session: null as any, denied: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const denied = await checkShopFeatureGate(Number(session.shopId), ["auto_dvi"], {
    isPlatformAdmin: session.role === "platform_admin",
    featureLabel: "Auto DVI",
  });
  return { session, denied };
}

export async function GET(req: NextRequest) {
  const { session, denied } = await gate();
  if (denied) return denied;
  const vin = (req.nextUrl.searchParams.get("vin") || "").toUpperCase().trim();
  if (!vin) return NextResponse.json({ error: "vin is required" }, { status: 400 });
  const doc = await readInspectionResults(Number(session.shopId), vin);
  return NextResponse.json({ ok: true, results: doc });
}

const VALID_RATINGS = new Set(["green", "yellow", "red"]);

export async function POST(req: NextRequest) {
  const { session, denied } = await gate();
  if (denied) return denied;
  let body: {
    vin?: string;
    items?: Array<{
      itemId?: string;
      name?: string;
      rating?: string | null;
      notes?: string | null;
      recommendation?: string | null;
    }>;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const vin = (body.vin || "").toUpperCase().trim();
  if (!vin) return NextResponse.json({ error: "vin is required" }, { status: 400 });
  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (rawItems.length === 0 || rawItems.length > MAX_ITEMS) {
    return NextResponse.json({ error: `items must contain 1-${MAX_ITEMS} entries` }, { status: 400 });
  }
  const items = [];
  for (const it of rawItems) {
    if (!it?.itemId || typeof it.itemId !== "string") {
      return NextResponse.json({ error: "each item needs an itemId" }, { status: 400 });
    }
    if (it.rating != null && !VALID_RATINGS.has(it.rating)) {
      return NextResponse.json({ error: `invalid rating "${it.rating}"` }, { status: 400 });
    }
    items.push({
      itemId: it.itemId.slice(0, 200),
      name: String(it.name || "").slice(0, 200),
      rating: it.rating === undefined ? undefined : ((it.rating as InspectionRating) ?? null),
      notes: it.notes === undefined ? undefined : it.notes ? String(it.notes).slice(0, MAX_TEXT) : null,
      recommendation:
        it.recommendation === undefined
          ? undefined
          : it.recommendation
            ? String(it.recommendation).slice(0, MAX_TEXT)
            : null,
    });
  }
  const doc = await saveInspectionResults({
    shopId: Number(session.shopId),
    vinUpper: vin,
    items,
    updatedBy: session.email || null,
  });
  return NextResponse.json({ ok: true, results: doc });
}
