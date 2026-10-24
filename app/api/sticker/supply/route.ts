import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { checkShopFeatureGate } from "@/lib/extension-route-guard";
import { changeStickerSupply, readStickerSupply } from "@/lib/sticker-activity";

export const dynamic = "force-dynamic";
import { stickerSupplyDeps } from "@/lib/sticker-supply-deps";
export async function GET() {
  const session = await stickerSupplyDeps.getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const gate = await stickerSupplyDeps.checkShopFeatureGate(session.shopId, ["oil_sticker"], { isPlatformAdmin: session.isPlatformAdmin });
  if (gate) return gate;
  try {
    return NextResponse.json({
      supply: await readStickerSupply(await stickerSupplyDeps.getDb(), Number(session.shopId)),
      canManage: session.isPlatformAdmin || ["owner", "admin"].includes(session.role),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Supply estimate unavailable" }, { status: 503 });
  }
}
export async function POST(req: NextRequest) {
  const session = await stickerSupplyDeps.getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!session.isPlatformAdmin && !["owner", "admin"].includes(session.role)) {
    return NextResponse.json({ error: "Only shop owners and admins can manage roll estimates" }, { status: 403 });
  }
  const gate = await stickerSupplyDeps.checkShopFeatureGate(session.shopId, ["oil_sticker"], { isPlatformAdmin: session.isPlatformAdmin });
  if (gate) return gate;
  let body;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  try {
    if (!await changeStickerSupply(await stickerSupplyDeps.getDb(), Number(session.shopId), body)) {
      return NextResponse.json({ error: "Roll settings changed. Refresh before trying again." }, { status: 409 });
    }
    return NextResponse.json({ success: true });
  } catch (error: any) {
    const invalid = /Capacity must|revision required|Invalid operation/.test(error.message);
    return NextResponse.json({ error: invalid ? error.message : "Supply estimate unavailable" }, { status: invalid ? 400 : 503 });
  }
}
