import { NextResponse } from "next/server";
import { isCrmEnabled } from "./crm";

/**
 * Returns a 404 NextResponse if the CRM subsystem is disabled, otherwise null.
 * Use at the top of every gated API route handler:
 *
 *   const gated = crmDisabledResponse();
 *   if (gated) return gated;
 */
export function crmDisabledResponse(): NextResponse | null {
  if (isCrmEnabled()) return null;
  return NextResponse.json({ error: "Not Found" }, { status: 404 });
}
