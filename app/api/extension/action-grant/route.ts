import { NextRequest, NextResponse } from "next/server";
import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { guardExtensionShopRequest } from "@/lib/extension-route-guard";
import { issueExtensionActionGrant } from "@/lib/extension-action-grant";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

async function _POST(request: NextRequest) {
  if (process.env.EXTENSION_ACTION_GRANTS_DISABLED === "true") {
    return NextResponse.json(
      { error: "Provider action grants are temporarily disabled" },
      { status: 503, headers: corsHeaders },
    );
  }

  const body = await request.json().catch(() => ({}));
  const provider = String(body.provider || "").toLowerCase();
  const smsShopId = String(body.smsShopId || "");
  const action = String(body.action || "");
  if (!provider || !smsShopId || !action) {
    return NextResponse.json(
      { error: "provider, smsShopId, and action are required" },
      { status: 400, headers: corsHeaders },
    );
  }

  const guarded = await guardExtensionShopRequest(request, {
    smsShopId,
    provider,
    requiredCapabilities: ["provider_action"],
    corsHeaders,
  });
  if (!guarded.ok) return guarded.response;
  if (guarded.provider !== provider) {
    return NextResponse.json(
      { error: "Provider scope mismatch", code: "PROVIDER_FORBIDDEN" },
      { status: 403, headers: corsHeaders },
    );
  }

  const issued = issueExtensionActionGrant({
    sessionId: guarded.principal.sessionId,
    shopId: guarded.mosShopId,
    provider: guarded.provider,
    action,
  });
  console.info(
    `[Extension Action Grant] issued shop=${guarded.mosShopId} provider=${guarded.provider} action=${action}`,
  );
  return NextResponse.json(
    {
      ok: true,
      grant: issued.grant,
      expiresAt: new Date(issued.claims.expiresAt * 1000).toISOString(),
      shopId: guarded.mosShopId,
      provider: guarded.provider,
      action,
    },
    { headers: corsHeaders },
  );
}

export const POST = withExtensionErrorMarker(_POST as any);