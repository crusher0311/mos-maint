// Task #681 — real part cost for Protractor pushes.
//
// Protractor invoice/canned-job lines carry the shop's actual part cost in
// flat `Cost` / `TotalCost` fields (list-vs-detail probe 2026-06-05). When a
// pushed line carries that real cost we write it through unchanged; when it
// doesn't (AI-built jobs, knowledge-base parts, thin history rows indexed
// before cost capture) we fall back to a per-shop estimate ratio applied to
// retail. The ratio lives on the shops doc (`partCostEstimateRatio`) and
// defaults to the historical hardcoded 0.6.

import { findShopByShopId } from "@/lib/data/repositories/shops";

export const DEFAULT_PART_COST_RATIO = 0.6;

// Guardrails for the configurable ratio: a cost ratio at or below 0 is
// meaningless, and anything above 1.5 almost certainly means the value was
// entered as a percentage (e.g. "60") — reject rather than silently write
// absurd costs into the shop's accounting.
export const MIN_PART_COST_RATIO = 0.05;
export const MAX_PART_COST_RATIO = 1.5;

export function isValidPartCostRatio(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_PART_COST_RATIO &&
    value <= MAX_PART_COST_RATIO
  );
}

/**
 * Read the shop's configured cost-estimate ratio, falling back to the
 * historical default (0.6) when unset/invalid or when the lookup fails.
 * Never throws — a cost estimate must not block a work-order push.
 */
export async function getShopPartCostRatio(shopId: number | string): Promise<number> {
  try {
    const shop = await findShopByShopId(shopId, { partCostEstimateRatio: 1 });
    const raw = Number((shop as any)?.partCostEstimateRatio);
    if (isValidPartCostRatio(raw)) return raw;
  } catch (err: any) {
    console.warn(
      `[PartCost] Failed to read partCostEstimateRatio for shop ${shopId}: ${err?.message || err}`,
    );
  }
  return DEFAULT_PART_COST_RATIO;
}

export type ResolvedPartCost = {
  /** Per-unit cost to write into Protractor's `Cost` field. */
  unitCost: number;
  /** Extended cost to write into Protractor's `TotalCost` field. */
  totalCost: number;
  /** Whether the cost came from real source data or the ratio estimate. */
  source: "real" | "estimated";
};

/**
 * Resolve the cost for a non-labor line about to be pushed to Protractor.
 * Uses the line's real unit cost when present and positive; otherwise
 * estimates from retail via the shop's configured ratio.
 */
export function resolvePartLineCost(
  line: {
    quantity?: number;
    unitPrice?: number;
    extendedPrice?: number;
    cost?: number;
    extendedCost?: number;
  },
  ratio: number,
): ResolvedPartCost {
  const qty =
    typeof line.quantity === "number" && Number.isFinite(line.quantity) && line.quantity > 0
      ? line.quantity
      : 1;
  const unitPrice =
    typeof line.unitPrice === "number" && Number.isFinite(line.unitPrice) ? line.unitPrice : 0;
  const extendedPrice =
    typeof line.extendedPrice === "number" && Number.isFinite(line.extendedPrice) && line.extendedPrice > 0
      ? line.extendedPrice
      : qty * unitPrice;

  const unitCost = Number(line.cost);
  if (Number.isFinite(unitCost) && unitCost > 0) {
    const extendedCost = Number(line.extendedCost);
    return {
      unitCost,
      totalCost:
        Number.isFinite(extendedCost) && extendedCost > 0 ? extendedCost : unitCost * qty,
      source: "real",
    };
  }

  // No usable unit cost — an extended cost alone can still anchor the line.
  const extendedCostOnly = Number(line.extendedCost);
  if (Number.isFinite(extendedCostOnly) && extendedCostOnly > 0) {
    return {
      unitCost: extendedCostOnly / qty,
      totalCost: extendedCostOnly,
      source: "real",
    };
  }

  return {
    unitCost: unitPrice * ratio,
    totalCost: extendedPrice * ratio,
    source: "estimated",
  };
}

/**
 * Extract the real per-unit + extended cost from a raw Protractor line
 * (invoice/WO detail, canned-job template, or an already-normalized line).
 * Returns undefined fields when no positive cost is present. Labor lines
 * should NOT be passed here — Protractor's labor `TotalCost` is the labor
 * total, not a parts cost.
 */
export function extractProtractorLineCost(l: any): {
  cost?: number;
  extendedCost?: number;
} {
  const toNum = (v: any): number => {
    if (v === null || v === undefined || v === "") return NaN;
    const n = parseFloat(String(v));
    return Number.isFinite(n) ? n : NaN;
  };

  let cost = NaN;
  for (const c of [l?.Cost, l?.cost]) {
    const n = toNum(c);
    if (Number.isFinite(n) && n > 0) {
      cost = n;
      break;
    }
  }

  let extendedCost = NaN;
  for (const c of [l?.TotalCost, l?.totalCost, l?.extendedCost]) {
    const n = toNum(c);
    if (Number.isFinite(n) && n > 0) {
      extendedCost = n;
      break;
    }
  }

  // Derive unit cost from the extended cost when only the total is present.
  if (!Number.isFinite(cost) && Number.isFinite(extendedCost)) {
    const qty = toNum(l?.Quantity ?? l?.quantity);
    if (Number.isFinite(qty) && qty > 0) cost = extendedCost / qty;
    else cost = extendedCost;
  }

  return {
    cost: Number.isFinite(cost) && cost > 0 ? cost : undefined,
    extendedCost: Number.isFinite(extendedCost) && extendedCost > 0 ? extendedCost : undefined,
  };
}

/**
 * One-line log per pushed part line so real-vs-estimated cost usage is
 * visible in production logs (Better Stack) without dumping full payloads.
 */
export function logPartCostResolution(opts: {
  tag: string;
  shopId: number | string;
  jobTitle: string;
  description: string;
  resolved: ResolvedPartCost;
  ratio: number;
  unitPrice: number;
}): void {
  const { tag, shopId, jobTitle, description, resolved, ratio, unitPrice } = opts;
  console.log(
    `[PartCost]${tag} shop=${shopId} job="${jobTitle}" line="${description}" ` +
      `source=${resolved.source} unitCost=${resolved.unitCost.toFixed(2)} ` +
      `totalCost=${resolved.totalCost.toFixed(2)} retail=${unitPrice.toFixed(2)}` +
      (resolved.source === "estimated" ? ` ratio=${ratio}` : ""),
  );
}
