// Task #991 — customer-facing DVI media: streams an inspection photo/video
// on the shared report, authorized by the SAME HMAC share token as the
// report itself (no session — customers are anonymous). The token pins both
// VIN and shop, and readInspectionMedia enforces shop ownership of the file.

import { NextRequest, NextResponse } from "next/server";
import { verifyShareToken } from "@/lib/report-share";
import { readInspectionMedia } from "@/lib/data/repositories/auto-dvi";
import { getFeatureEntitlements } from "@/lib/featureResolver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: { vin: string; mediaId: string } },
) {
  const vin = (params.vin || "").toUpperCase();
  const token = req.nextUrl.searchParams.get("token") || "";
  const verified = token ? verifyShareToken(token) : null;
  if (!verified || verified.vin !== vin) {
    return NextResponse.json({ error: "Invalid or expired report link" }, { status: 403 });
  }
  const entitlements = await getFeatureEntitlements(Number(verified.shopId));
  if (!entitlements.canUseFeature("maintenance")) {
    return NextResponse.json({ error: "Feature not enabled" }, { status: 403 });
  }
  const media = await readInspectionMedia(Number(verified.shopId), params.mediaId);
  if (!media) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return new NextResponse(media.buffer as any, {
    headers: {
      "Content-Type": media.contentType,
      "Content-Length": String(media.buffer.length),
      "Cache-Control": "private, max-age=3600",
      ...(media.filename
        ? { "Content-Disposition": `inline; filename="${media.filename.replace(/"/g, "")}"` }
        : {}),
    },
  });
}
