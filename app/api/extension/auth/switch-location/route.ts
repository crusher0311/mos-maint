import { NextResponse } from "next/server";
import { switchLocation, corsHeaders } from "@/lib/extension-location-session";
import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { validateExtensionToken } from "@/lib/extension-auth";
export const POST = withExtensionErrorMarker(async request => {
  const auth = await validateExtensionToken(request);
  return switchLocation(request, auth);
});
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}
