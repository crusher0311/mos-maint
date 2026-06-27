// Task #695 — Shop-Ware LIVE webhook job_index builder.
//
// The Shop-Ware webhook (app/api/webhooks/shopware/route.ts) does NOT go
// through NormalizedIngestionService, so it builds its own job_index entries.
// This module holds that builder as a *pure*, server-only-free function so it
// can be regression-tested without dragging in the route's full module graph
// (NextResponse, AutoFlow's `server-only` client, etc.).
//
// It mirrors the canonical Tekmetric live indexer + the Shop-Ware normalized
// dual-writer (buildShopWareLinesByJob): VIN-decoded ACES IDs nested under
// `vehicle.*`, and per-line PCDB / PartsTech IDs on each part line.

import type {
  ShopWareRepairOrder,
  ShopWareService,
} from "@/lib/integrations/shopware/types";
import { extractShopWarePcdb, type AcesEnrichment } from "@/lib/job-index-aces";
import type { ShopwareJobIndexEntry } from "@/lib/data/repositories/shopware-cache";

// Build the per-service-job line array (labor + parts) with line-level PCDB /
// PartsTech IDs attached to each part line. PCDB comes from each part's
// `integrator_tags` (requested via the integrator_tags association on
// getRepairOrder); absent when the SW API/shop doesn't surface them, in which
// case the part line is still emitted without PCDB IDs.
export function buildShopwareServiceLines(
  service: ShopWareService,
): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  for (const labor of service.labors ?? []) {
    lines.push({
      lineType: "labor",
      description: labor.name,
      quantity: 1,
      unitPrice: 0,
      extendedPrice: 0,
      hours: labor.hours,
    });
  }
  for (const part of service.parts ?? []) {
    const qty = part.quantity || 1;
    const unit = (part.sell_price_cents ?? 0) / 100;
    lines.push({
      lineType: "part",
      description: part.description || (part as any).name || "",
      partNumber: part.number ?? (part as any).part_number ?? (part as any).partNumber,
      manufacturer: part.brand,
      quantity: qty,
      unitPrice: unit,
      extendedPrice: qty * unit,
      ...extractShopWarePcdb(part),
    });
  }
  return lines;
}

// Pure given (mosShopId, ro, tenantId, aces). The caller decodes the RO VIN to
// ACES once and passes it in; null aces (ambiguous squish / decode failure)
// still indexes the jobs with their lines+PCDB.
export function extractShopwareJobIndex(
  mosShopId: number,
  ro: ShopWareRepairOrder,
  tenantId: number,
  aces?: AcesEnrichment | null,
): ShopwareJobIndexEntry[] {
  const vin = ro.vehicle?.vin?.toUpperCase() ?? null;
  const entries: ShopwareJobIndexEntry[] = [];

  const roMileage =
    (typeof (ro as any).odometer_out === "number" && (ro as any).odometer_out > 0 ? (ro as any).odometer_out : null) ??
    (typeof (ro as any).odometer === "number" && (ro as any).odometer > 0 ? (ro as any).odometer : null) ??
    (typeof (ro as any).odometer_in === "number" && (ro as any).odometer_in > 0 ? (ro as any).odometer_in : null) ??
    null;

  const vehicleYear = ro.vehicle?.year ? parseInt(ro.vehicle.year, 10) : undefined;

  // Vehicle subdoc carrying DataOne ACES IDs, nested under `vehicle.*` to match
  // the canonical Tekmetric live-indexer shape that the coverage tooling reads.
  // Y/M/M stay as Shop-Ware supplied them; the ACES IDs (and submodelKey) come
  // from the DataOne decode and are null when the squish is ambiguous.
  const vehicleSubdoc = {
    vin,
    year: vehicleYear,
    make: ro.vehicle?.make,
    model: ro.vehicle?.model,
    acesVehicleId: aces?.acesVehicleId ?? null,
    acesEngineId: aces?.acesEngineId ?? null,
    submodelKey: aces?.submodelKey ?? null,
    acesDecodedAt: aces?.acesDecodedAt ?? null,
  };

  for (const service of ro.services ?? []) {
    const laborHours = (service.labors ?? []).reduce((s, l) => s + l.hours, 0);
    const partsAmount = (service.parts ?? []).reduce(
      (s, p) => s + ((p.sell_price_cents ?? 0) / 100) * p.quantity,
      0,
    );
    const subletsAmount = (service.sublets ?? []).reduce(
      (s, sub) => s + (sub.price_cents ?? 0) / 100,
      0,
    );
    let laborAmount = 0;
    if (service.is_fixed_price_service && service.fixed_price_labor_total_cents != null) {
      laborAmount = service.fixed_price_labor_total_cents / 100;
    }
    const totalAmount = laborAmount + partsAmount + subletsAmount;

    entries.push({
      shopId: mosShopId,
      provider: "shopware",
      tenantId,
      workOrderId: String(ro.id),
      workOrderNumber: ro.number,
      servicePackageId: String(service.id),
      title: service.title,
      status: service.completed ? "completed" : "open",
      vin,
      vehicleYear,
      vehicleMake: ro.vehicle?.make,
      vehicleModel: ro.vehicle?.model,
      vehicle: vehicleSubdoc,
      lines: buildShopwareServiceLines(service),
      laborHours,
      laborAmount,
      partsAmount,
      totalAmount,
      completedAt: ro.closed_at ? new Date(ro.closed_at) : undefined,
      mileage: roMileage,
      indexedAt: new Date(),
    });
  }

  return entries;
}
