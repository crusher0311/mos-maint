import {NextRequest, NextResponse} from "next/server";
import {inspectionHistory} from "@/lib/auto-dvi/staff/history";
import {staffDependencies} from "@/lib/auto-dvi/staff/runtime";
import {readInspectionResults, readDviVisits, readInspectionMedia, readDviVisitMedia} from "@/lib/data/repositories/auto-dvi";
import {findCachedWorkOrderById} from "@/lib/data/repositories/protractor-work-orders";
import {findLatestDviResultByRoOrVin} from "@/lib/data/repositories/dvi";
import {dispatchJson, dispatchFailure} from "@/lib/shop-dispatch/http";
import {requireThat} from "@/lib/shop-dispatch/model";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const dependencies = {
  staff: staffDependencies, legacy: readInspectionResults, intermediate: readDviVisits,
  imported: async (shop: number, vin: string) => {
    const row = await findLatestDviResultByRoOrVin(shop, "", vin);
    return row?.vin === vin ? row : null;
  },
  vehicle: async (shop: number, sourceId: string) => {
    const row = await findCachedWorkOrderById(shop, sourceId);
    return row?.workOrderId === sourceId && typeof row.vin === "string" ? row.vin.toUpperCase() : null;
  },
};
export async function GET(req: NextRequest) {
  try {
    const p = req.nextUrl.searchParams, visitId = p.get("visitId") ?? "";
    const access = await staffDependencies.access();
    const history = await inspectionHistory(visitId, dependencies);
    const mediaId = p.get("mediaId");
    if (!mediaId) return dispatchJson(history);
    requireThat(/^[a-f0-9]{24}$/.test(mediaId), "Invalid historical media", 400);
    const row = history.rows.find(r => r.id === p.get("recordId"));
    const media = row?.items.flatMap(i => i.media).find(m => m.id === mediaId);
    requireThat(media, "Media not attached to this historical reference", 404);
    let file;
    if (media.origin === "legacy") file = await readInspectionMedia(access.shopId, mediaId);
    else {
      const board = await staffDependencies.board.read(access.shopId);
      const visit = board.visits.find(v => v.id === visitId)!;
      const vin = visit.provider === "protractor" && visit.sourceId
        ? await dependencies.vehicle(access.shopId, visit.sourceId) : visit.intake?.details.newVehicle?.vin;
      requireThat(vin, "Canonical VIN unavailable", 409);
      file = await readDviVisitMedia(access.shopId, vin, media.recordId, mediaId);
    }
    requireThat(file, "Historical media unavailable", 404);
    const after = await inspectionHistory(visitId, dependencies);
    const fresh = await staffDependencies.access();
    requireThat(fresh.shopId === access.shopId && fresh.actor === access.actor &&
      after.rows.some(r => r.id === row!.id && r.items.some(i => i.media.some(m => m.id === mediaId))), "History access changed", 403);
    requireThat(/^image\/(jpeg|png|webp|gif)$|^video\/(mp4|webm|quicktime)$/.test(file.contentType), "Unsupported historical media", 415);
    return new NextResponse(new Uint8Array(file.buffer), {headers: {"Content-Type": file.contentType,
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox"}});
  } catch (cause) {return dispatchFailure(cause);}
}
