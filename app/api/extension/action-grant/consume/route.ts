import { NextRequest, NextResponse } from "next/server";
import { consumeExtensionActionGrant } from "@/lib/extension-action-grant";
import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

async function _POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const grant = String(body.grant || "");
  const provider = String(body.provider || "").toLowerCase();
  const action = String(body.action || "");
  if (!grant || !provider || !action) {
    return NextResponse.json(
      { error: "grant, provider, and action are required" },
      { status: 400, headers: corsHeaders },
    );
  }
  const consumed = await consumeExtensionActionGrant(grant, {
    provider,
    action,
  });
  if (consumed.status !== "consumed" || !consumed.claims) {
    return NextResponse.json(
      {
        error:
          consumed.status === "replayed"
            ? "Provider action grant was already used"
            : "Provider action grant is invalid or its session is inactive",
        code:
          consumed.status === "replayed"
            ? "PROVIDER_ACTION_GRANT_REPLAYED"
            : "PROVIDER_ACTION_GRANT_INVALID",
      },
      { status: 403, headers: corsHeaders },
    );
  }
  return NextResponse.json(
    {
      ok: true,
      consumed: true,
      shopId: consumed.claims.shopId,
      provider: consumed.claims.provider,
      action: consumed.claims.action,
      expiresAt: new Date(consumed.claims.expiresAt * 1000).toISOString(),
    },
    { headers: corsHeaders },
  );
}

export const POST = withExtensionErrorMarker(_POST as any);