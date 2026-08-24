// Task #991 — Auto DVI: server-side inspection composer. Given a shop +
// VIN (+ optional mileage from the open RO), rebuilds/reads the cached VHI,
// collects overdue / due-soon / OE inspect-only items, merges the shop's
// custom inspection items, and computes coverage-based dedup. All pure
// decisions live in ./compose (unit-tested without server-only imports).

import { readShopAutoDviItems, readVinMileageContext } from "@/lib/data/repositories/auto-dvi";
import { estimateMileageWhenMissing } from "@/lib/vhi-mileage-fallbacks";
import { rebuildVhi } from "@/lib/vhi-rebuild";
import {
  buildRecallInspectionItems,
  collectVhiInspectionItems,
  composeInspectionChecklist,
  type ComposedInspection,
  type ShopInspectionItem,
} from "./compose";
import { getVehicleRecallsLocal } from "@/lib/integrations/dataone-local";
import { resolveShopItemKeys } from "./resolve-keys";

export interface AutoDviResult extends ComposedInspection {
  ok: true;
  vin: string;
  vehicle: { year?: number | null; make?: string | null; model?: string | null } | null;
  score: number | null;
  mileage: number | null;
  generatedAt: string;
}

export interface AutoDviError {
  ok: false;
  error: string;
}

/** Read the shop's custom inspection items (settings page storage). */
export async function getShopInspectionItems(shopId: number): Promise<ShopInspectionItem[]> {
  const raw = await readShopAutoDviItems(shopId);
  return raw
    .filter((it: any) => it && typeof it.name === "string" && it.name.trim())
    .map((it: any) => ({
      id: String(it.id || it.name),
      name: String(it.name).trim(),
      group: it.group ? String(it.group) : null,
      notes: it.notes ? String(it.notes) : null,
    }));
}

export async function composeAutoDvi(opts: {
  shopId: number;
  vin: string;
  mileage?: number | null;
}): Promise<AutoDviResult | AutoDviError> {
  const vin = (opts.vin || "").toUpperCase().trim();
  if (!vin) return { ok: false, error: "vin is required" };

  // rebuildVhi refuses mileage <= 0, so when the caller has no odometer
  // (dashboard plan page) resolve one with the standard waterfall:
  // open-RO odometer → CARFAX projection → stale vehicles snapshot →
  // year×12k annual estimate. Same anchor order as the partner VHI routes.
  let mileage = Number(opts.mileage) || 0;
  if (mileage <= 0) {
    const ctx = await readVinMileageContext(opts.shopId, vin);
    if (ctx.openRoMiles) {
      mileage = ctx.openRoMiles;
    } else {
      const est = await estimateMileageWhenMissing({
        shopId: opts.shopId,
        vin,
        knownYear: ctx.knownYear,
        vehicleDocMileage: ctx.vehicleDocMileage,
      }).catch(() => null);
      if (est) mileage = est.mileage;
    }
  }

  const [vhi, shopItemsRaw, recallsRes] = await Promise.all([
    // fast:true — interactive latency; falls back to cached plan when a
    // full rebuild would be slow. Same setting the prefill-dvi route uses.
    rebuildVhi(opts.shopId, vin, mileage, { fast: true }),
    getShopInspectionItems(opts.shopId),
    // Open safety recalls join the inspection scope (best-effort — a recall
    // lookup failure never blocks generation).
    getVehicleRecallsLocal(vin).catch(() => null),
  ]);

  if (!vhi || !vhi.success) {
    return { ok: false, error: vhi?.error || "Could not build vehicle health inspection" };
  }

  const buckets = {
    overdue: vhi.buckets?.overdue || [],
    dueSoon: vhi.buckets?.dueSoon || [],
    upcoming: vhi.buckets?.upcoming || [],
  };
  const vhiItems = collectVhiInspectionItems(buckets);
  const shopItems = await resolveShopItemKeys(opts.shopId, shopItemsRaw);
  const { items, hidden } = composeInspectionChecklist({ vhiItems, shopItems });
  // Recalls lead the checklist — safety-critical items first.
  const recallItems = buildRecallInspectionItems((recallsRes as any)?.recalls || []);
  if (recallItems.length > 0) items.unshift(...recallItems);

  return {
    ok: true,
    vin,
    vehicle: vhi.vehicle
      ? {
          year: vhi.vehicle.year ?? null,
          make: vhi.vehicle.make ?? null,
          model: vhi.vehicle.model ?? null,
        }
      : null,
    score: typeof vhi.score?.value === "number" ? vhi.score.value : null,
    mileage: typeof vhi.currentMiles === "number" ? vhi.currentMiles : (opts.mileage ?? null),
    items,
    hidden,
    generatedAt: new Date().toISOString(),
  };
}
