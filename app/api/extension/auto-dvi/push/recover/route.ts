import { NextRequest, NextResponse } from "next/server";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";
import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { AUTO_DVI_REQUIRED_FEATURES } from "@/lib/shop-feature-access";
import { durableRecovery } from "@/lib/auto-dvi/durable/recovery-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const corsHeaders = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization", "Cache-Control": "private, no-store"};
export async function OPTIONS() { return new NextResponse(null, {status: 204, headers: corsHeaders}); }
export const POST = withExtensionErrorMarker(async (req: NextRequest) => {
  const guard = await guardExtensionShopRequest(req, {
    smsShopId: new URL(req.url).searchParams.get("shopId") || "", provider: "protractor",
    requiredFeatures: AUTO_DVI_REQUIRED_FEATURES, featureLabel: "Auto DVI", corsHeaders,
  });
  if (!guard.ok) return guard.response;
  return durableRecovery(req, {shopId: guard.mosShopId, actor: guard.user?.email || ""}, corsHeaders);
});
