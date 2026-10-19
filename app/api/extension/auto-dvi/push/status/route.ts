import { NextRequest, NextResponse } from "next/server";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";
import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { AUTO_DVI_REQUIRED_FEATURES } from "@/lib/shop-feature-access";
import { durableStatus } from "@/lib/auto-dvi/durable/status-handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const corsHeaders = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"};
export async function OPTIONS() { return new NextResponse(null, {status: 204, headers: corsHeaders}); }
async function handle(req: NextRequest) {
  const guard = await guardExtensionShopRequest(req, {
    smsShopId: new URL(req.url).searchParams.get("shopId") || "",
    provider: "protractor", requiredFeatures: AUTO_DVI_REQUIRED_FEATURES, featureLabel: "Auto DVI", corsHeaders,
  });
  if (!guard.ok) return guard.response;
  return durableStatus(req, {shopId: guard.mosShopId, actor: guard.user?.email || ""}, req.method === "POST", corsHeaders);
}
export const GET = withExtensionErrorMarker(handle as any);
export const POST = withExtensionErrorMarker(handle as any);
