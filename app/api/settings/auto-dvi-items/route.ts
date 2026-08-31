// Task #991 — Auto DVI: per-shop custom inspection line items (name +
// optional group + optional notes). Stored alongside the other shop
// preferences (shops.preferences.autoDviItems) and edited from
// /dashboard/settings/auto-dvi. Auto DVI consumes VHI maintenance data, so
// both product entitlements are required.

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  readShopAutoDviItems,
  writeShopAutoDviItems,
} from "@/lib/data/repositories/auto-dvi";
import { checkShopFeatureGate } from "@/lib/extension-route-guard";
import {
  AUTO_DVI_REQUIRED_FEATURES,
  canPlatformAdminBypassShopFeatures,
} from "@/lib/shop-feature-access";
import { randomUUID } from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ITEMS = 200;
const MAX_NAME = 120;
const MAX_GROUP = 60;
const MAX_NOTES = 500;

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const shopId = Number(session.shopId);
  const isPlatformAdmin = session.role === "platform_admin";
  const denied = await checkShopFeatureGate(shopId, AUTO_DVI_REQUIRED_FEATURES, {
    isPlatformAdmin: canPlatformAdminBypassShopFeatures(session),
    featureLabel: "Auto DVI",
  });
  if (denied) return denied;

  const items = await readShopAutoDviItems(shopId);
  return NextResponse.json({ ok: true, items });
}

export async function PUT(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const shopId = Number(session.shopId);
  const isPlatformAdmin = session.role === "platform_admin";
  const denied = await checkShopFeatureGate(shopId, AUTO_DVI_REQUIRED_FEATURES, {
    isPlatformAdmin: canPlatformAdminBypassShopFeatures(session),
    featureLabel: "Auto DVI",
  });
  if (denied) return denied;

  let body: { items?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!Array.isArray(body.items)) {
    return NextResponse.json({ error: "items must be an array" }, { status: 400 });
  }
  if (body.items.length > MAX_ITEMS) {
    return NextResponse.json({ error: `Too many items (max ${MAX_ITEMS})` }, { status: 400 });
  }

  const items: Array<{ id: string; name: string; group: string | null; notes: string | null }> = [];
  for (const raw of body.items as any[]) {
    const name = typeof raw?.name === "string" ? raw.name.trim() : "";
    if (!name) {
      return NextResponse.json({ error: "Every item needs a name" }, { status: 400 });
    }
    if (name.length > MAX_NAME) {
      return NextResponse.json({ error: `Item name too long (max ${MAX_NAME} chars)` }, { status: 400 });
    }
    const group = typeof raw?.group === "string" && raw.group.trim() ? raw.group.trim().slice(0, MAX_GROUP) : null;
    const notes = typeof raw?.notes === "string" && raw.notes.trim() ? raw.notes.trim().slice(0, MAX_NOTES) : null;
    items.push({
      id: typeof raw?.id === "string" && raw.id ? raw.id : randomUUID(),
      name,
      group,
      notes,
    });
  }

  await writeShopAutoDviItems(shopId, items);
  return NextResponse.json({ ok: true, items });
}
