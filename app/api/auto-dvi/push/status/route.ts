import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { checkShopFeatureGate } from "@/lib/extension-route-guard";
import { durableStatus } from "@/lib/auto-dvi/durable/status-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({error: "Unauthorized"}, {status: 401});
  const shopId = Number(session.shopId);
  const denied = await checkShopFeatureGate(shopId, ["maintenance", "auto_dvi"], {
    isPlatformAdmin: session.role === "platform_admin" && !session.isImpersonation, featureLabel: "Auto DVI",
  });
  if (denied) return denied;
  return durableStatus(req, {shopId, actor: session.email}, false);
}
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({error: "Unauthorized"}, {status: 401});
  const shopId = Number(session.shopId);
  const denied = await checkShopFeatureGate(shopId, ["maintenance", "auto_dvi"], {
    isPlatformAdmin: session.role === "platform_admin" && !session.isImpersonation, featureLabel: "Auto DVI",
  });
  if (denied) return denied;
  return durableStatus(req, {shopId, actor: session.email}, true);
}
