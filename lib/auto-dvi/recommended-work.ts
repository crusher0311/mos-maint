// Task #991 — Auto DVI: build priced recommended-work packages from the
// overdue / due-soon VHI items the user opted to add alongside the
// inspection record. Hours come from the estimate-assist history waterfall
// (vehicle-scoped shop history → shop-wide) with a 1.0h default; the rate is
// the shop's cached labor rate observed by job indexing (same source the
// add-to-RO flow falls back to). Everything here is best-effort — a pricing
// lookup failure never blocks the push, it just prices the line at the
// defaults.

import { getShopHistoricalAverage } from "@/lib/estimate-assist/job-knowledge-base";
import { resolveAddToRoLaborRate } from "@/lib/integrations/protractor/labor-rate";
import { readShopCachedLaborRate } from "@/lib/data/repositories/auto-dvi";

const DEFAULT_HOURS = 1.0;

export interface RecommendedWorkInput {
  name: string;
  serviceKey?: string | null;
}

export interface RecommendedWorkPackage {
  title: string;
  hours: number;
  rate: number;
  laborTotal: number;
  hoursSource: "history" | "default";
}

export async function buildRecommendedWorkPackages(opts: {
  shopId: number;
  vehicle?: { year?: number | null; make?: string | null; model?: string | null } | null;
  items: RecommendedWorkInput[];
}): Promise<{ packages: RecommendedWorkPackage[]; rate: number; rateSource: string }> {
  const { shopId, vehicle, items } = opts;

  const cachedLaborRate = await readShopCachedLaborRate(shopId).catch(() => null);
  const { rate, rateSource } = resolveAddToRoLaborRate({
    source: "auto_dvi",
    jobLaborRate: 0,
    roLaborRate: 0,
    cachedLaborRate: cachedLaborRate ?? 0,
  });

  const vehicleAttributes =
    vehicle && (vehicle.make || vehicle.model || vehicle.year)
      ? {
          make: vehicle.make || undefined,
          model: vehicle.model || undefined,
          year: vehicle.year || undefined,
        }
      : undefined;

  const packages: RecommendedWorkPackage[] = [];
  for (const item of items) {
    const name = String(item.name || "").trim();
    if (!name) continue;
    let hours = DEFAULT_HOURS;
    let hoursSource: RecommendedWorkPackage["hoursSource"] = "default";
    try {
      const hist = await getShopHistoricalAverage(shopId, name, vehicleAttributes);
      if (hist && Number.isFinite(hist.avgHours) && hist.avgHours > 0) {
        hours = Math.round(hist.avgHours * 10) / 10;
        hoursSource = "history";
      }
    } catch (err: any) {
      console.warn("[AutoDVI recommended-work] history lookup failed (non-fatal):", err?.message);
    }
    packages.push({
      title: name,
      hours,
      rate,
      laborTotal: Math.round(hours * rate * 100) / 100,
      hoursSource,
    });
  }
  return { packages, rate, rateSource };
}
