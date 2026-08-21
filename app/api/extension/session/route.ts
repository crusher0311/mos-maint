import { NextRequest, NextResponse } from "next/server";
import {
  buildAuthErrorBody,
  getAuthErrorStatus,
  validateExtensionToken,
} from "@/lib/extension-auth";
import { revokeExtensionSession } from "@/lib/extension-session";
import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

async function _DELETE(request: NextRequest) {
  const auth = await validateExtensionToken(request);
  if (!auth.authorized || !auth.principal) {
    return NextResponse.json(buildAuthErrorBody(auth), {
      status: getAuthErrorStatus(auth),
      headers: corsHeaders,
    });
  }
  if (!auth.principal.isLegacy) {
    await revokeExtensionSession(auth.principal.sessionId);
    console.info(
      `[Extension Session] revoked shop=${auth.principal.shopId} assurance=${auth.principal.assurance}`,
    );
  }
  return NextResponse.json({ ok: true }, { headers: corsHeaders });
}

export const DELETE = withExtensionErrorMarker(_DELETE as any);