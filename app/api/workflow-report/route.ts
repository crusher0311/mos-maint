import { NextRequest, NextResponse } from "next/server";
import { publicReport } from "@/lib/auto-dvi/release/service";
import { releaseDependencies } from "@/lib/auto-dvi/release/runtime";
import { requestBody } from "@/lib/shop-dispatch/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = {"Cache-Control": "private, no-store, max-age=0", "Pragma": "no-cache",
  "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'"};
// A bounded per-process concurrency/rate brake. Invalid requests consume budget
// too; no IP/token/content enters logs or long-lived maps.
let inFlight = 0, windowStart = 0, requests = 0;
export async function POST(req: NextRequest) {
  const now = Date.now();
  if (now - windowStart >= 60000) {windowStart = now; requests = 0;}
  if (++requests > 600 || inFlight >= 12)
    return NextResponse.json({error: "Report unavailable"}, {status: 429, headers: {...headers, "Retry-After": "60"}});
  inFlight++;
  try {
    const result = await publicReport(await requestBody(req), releaseDependencies);
    if ("bytes" in result) return new NextResponse(new Uint8Array(result.bytes), {headers: {...headers,
      "Content-Type": result.mime, "Content-Disposition": "inline; filename=\"inspection-photo\""}});
    return NextResponse.json(result, {headers});
  } catch {
    // Never log request bodies, tokens, raw DB errors, finding text or media IDs.
    return NextResponse.json({error: "Report unavailable"}, {status: 404, headers});
  } finally {inFlight--;}
}
