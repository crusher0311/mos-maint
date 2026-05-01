import { NextRequest, NextResponse } from "next/server";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";
import { logAdminAction } from "@/lib/audit-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function POST(request: NextRequest) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: corsHeaders });
  }

  const { smsShopId, provider, roId, roNumber, vin, summary, items } = body;

  const guard = await guardExtensionShopRequest(request, {
    smsShopId,
    provider,
    requiredFeatures: ["maintenance", "dvi_prefill"],
    featureLabel: "Build RO from VHI",
    corsHeaders,
  });
  if (!guard.ok) return guard.response;

  const advisorEmail = guard.user?.email || guard.user?.emailAddress || "unknown";
  const ipAddress = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined;
  const userAgent = request.headers.get("user-agent") || undefined;

  await logAdminAction({
    action: "build_ro_from_vhi",
    adminEmail: advisorEmail,
    targetShopId: guard.mosShopId,
    targetShopName: guard.shopDoc?.name || guard.shopDoc?.shopName || undefined,
    details: {
      provider: guard.provider,
      smsShopId: smsShopId != null ? String(smsShopId) : null,
      roId: roId ?? null,
      roNumber: roNumber ?? null,
      vin: typeof vin === "string" ? vin.toUpperCase() : null,
      summary: summary || {},
      items: Array.isArray(items)
        ? items.map((it: any) => ({
            serviceKey: it?.serviceKey ?? null,
            title: it?.title ?? null,
            status: it?.status ?? null,
            outcome: it?.outcome ?? null,
            concernCreated: !!it?.concernCreated,
            jobCreated: !!it?.jobCreated,
            jobId: it?.jobId ?? null,
            error: it?.error ?? null,
          }))
        : [],
    },
    ipAddress,
    userAgent,
  });

  return NextResponse.json({ success: true }, { headers: corsHeaders });
}
