import { NextRequest, NextResponse } from "next/server";
import { loadPublicMileageContext } from "@/lib/data/repositories/public-report-state";
import { authorizePublicReport, allowPublicMileage, overlayPublicReport, saveCustomerMileage, refreshPublicReport } from "@/lib/public-report-service";
import { validCustomerMileage } from "@/lib/public-report-mileage";
import { withUpstreamTimeout } from "@/lib/with-upstream-timeout";
import { resolveShopDistanceUnit, type ShopDistanceDoc } from "@/lib/shop-distance-unit";

export async function POST(req: NextRequest, { params }: { params: Promise<{ vin: string }> }) {
  return withUpstreamTimeout(submit(req, (await params).vin.toUpperCase()), 10_000, "public mileage submission",
    NextResponse.json({ error: "Mileage update could not be confirmed. Refresh the report before retrying." }, { status: 503 }));
}

async function submit(req: NextRequest, vin: string) {
  const deadline = Date.now() + 9000;
  try {
    // Reject browser cross-origin submissions even when a link was leaked.
    const origin = req.headers.get("origin");
    if (origin && origin !== req.nextUrl.origin) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
    const scope = await authorizePublicReport(vin, req.nextUrl.searchParams.get("token"));
    if (!scope) return NextResponse.json({ error: "Invalid or expired report link" }, { status: 403 });
    const { shopId } = scope;
    if (!await allowPublicMileage(shopId, vin, req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown")) {
      return NextResponse.json({ error: "Too many updates. Please try again in an hour." }, { status: 429, headers: { "Retry-After": "3600" } });
    }
    // Stream with an actual cap; Content-Length alone is not trustworthy.
    const reader = req.body?.getReader();
    if (!reader) return NextResponse.json({ error: "Missing mileage" }, { status: 400 });
    let text = "";
    let bytes = 0;
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 256) {
        await reader.cancel();
        return NextResponse.json({ error: "Request too large" }, { status: 413 });
      }
      text += decoder.decode(value, { stream: true });
    }
    let body: any;
    try { body = JSON.parse(text); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
    const mileage = body?.mileage;
    if (!validCustomerMileage(mileage)) return NextResponse.json({ error: "Enter a whole number between 101 and 999,999." }, { status: 400 });
    const { shop, cached, vehicle, ro } = await loadPublicMileageContext(shopId, vin);
    if (!shop || !cached?.plan) return NextResponse.json({ error: "Report not available yet" }, { status: 404 });
    const distanceUnit = resolveShopDistanceUnit(shop as ShopDistanceDoc);
    const projected = await overlayPublicReport(undefined, shopId, vin, cached, distanceUnit);
    const known = Math.max(projected.currentMiles || 0, vehicle?.currentMileage || 0, vehicle?.lastMileage || 0, ro?.miles || 0);
    if (mileage < known) return NextResponse.json({ error: `Mileage must be at least ${known.toLocaleString()} ${distanceUnit}.` }, { status: 409 });
    if (Date.now() >= deadline) return NextResponse.json({ error: "Please try again." }, { status: 503 });
    const saved = await saveCustomerMileage(undefined, shopId, vin, {
      mileage, recordedAt: new Date(), source: "customer_entered", distanceUnit,
    });
    if (!saved) return NextResponse.json({ error: "A newer mileage reading was received. Refresh and try again." }, { status: 409 });
    void refreshPublicReport(undefined, shopId, vin, cached, { currentMiles: mileage, mileageEstimated: false }, true)
      .catch(() => console.warn("[Public report] Mileage refresh unavailable"));
    return NextResponse.json({ ok: true, mileage }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Unable to save mileage. Please try again." }, { status: 503 });
  }
}
