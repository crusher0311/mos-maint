/**
 * Task #803: Chemical-provider maintenance schedules ("Provider plans").
 *
 * A shop can define named provider schedules (e.g. "BG") with per-service
 * intervals, stored on the shop doc at `maintenance.chemicalProviders`.
 * Enabled providers surface as extra tabs on the dashboard VHI plan page —
 * the expensive fetch/anchor work runs once and only the interval
 * projection differs per tab.
 *
 * Storage mirrors the shop interval overrides exactly: `miles` is always
 * REAL MILES internally (the settings form converts km input on save), and
 * values are passed raw to triage the same way `maintenance.intervals` is.
 *
 * This module is pure (no "server-only", no DB imports) so it can be
 * unit-tested under tsx and shared by the plan-build route, the dashboard
 * plan page, and the settings page.
 */

import type { ShopIntervalOverride } from "@/lib/plan-build/triage";

export interface ChemicalProviderInterval {
  miles: number | null;
  months: number | null;
}

export interface ChemicalProvider {
  /** Stable id (slug), unique within the shop. */
  id: string;
  /** Display name, e.g. "BG". */
  name: string;
  /** Only enabled providers get a plan tab / cached plan variant. */
  enabled: boolean;
  /**
   * Set when the provider was created from a built-in template (e.g.
   * "bg-lpp"). Lets the plan page attach template-specific extras such as
   * protection-plan eligibility without storing rules in the shop doc.
   */
  templateId?: string | null;
  /** serviceKey -> interval. Only keys with at least one value matter. */
  intervals: Record<string, ChemicalProviderInterval>;
}

function sanitizeNumber(v: unknown): number | null {
  const n = typeof v === "string" ? parseInt(v, 10) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/**
 * Parses + sanitizes the raw `maintenance.chemicalProviders` array from a
 * shop doc. Tolerates missing/malformed entries (returns only valid ones)
 * so a bad write can never break plan builds.
 */
export function parseChemicalProviders(raw: unknown): ChemicalProvider[] {
  if (!Array.isArray(raw)) return [];
  const out: ChemicalProvider[] = [];
  const seenIds = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const id = typeof e.id === "string" ? e.id.trim() : "";
    const name = typeof e.name === "string" ? e.name.trim() : "";
    if (!id || !name || seenIds.has(id)) continue;
    seenIds.add(id);
    const intervals: Record<string, ChemicalProviderInterval> = {};
    if (e.intervals && typeof e.intervals === "object") {
      for (const [key, val] of Object.entries(e.intervals as Record<string, unknown>)) {
        if (!val || typeof val !== "object") continue;
        const v = val as Record<string, unknown>;
        const miles = sanitizeNumber(v.miles);
        const months = sanitizeNumber(v.months);
        if (miles != null || months != null) {
          intervals[key] = { miles, months };
        }
      }
    }
    const templateId =
      typeof e.templateId === "string" && e.templateId.trim()
        ? e.templateId.trim()
        : null;
    out.push({ id, name, enabled: e.enabled === true, templateId, intervals });
  }
  return out;
}

/**
 * Enabled providers that define at least one interval — only these produce
 * a plan variant/tab. (An enabled provider with zero intervals would just
 * duplicate the OE plan, so it's skipped.)
 */
export function getEnabledChemicalProviders(raw: unknown): ChemicalProvider[] {
  return parseChemicalProviders(raw).filter(
    (p) => p.enabled && Object.keys(p.intervals).length > 0
  );
}

/**
 * Projects a provider's intervals into the `shopIntervals` override shape
 * that `triage()` consumes (`useShop: true` so the override actually
 * applies; providers have no notion of "excluded").
 */
export function providerIntervalsToOverrides(
  provider: ChemicalProvider
): Record<string, ShopIntervalOverride> {
  const overrides: Record<string, ShopIntervalOverride> = {};
  for (const [key, iv] of Object.entries(provider.intervals)) {
    overrides[key] = {
      useShop: true,
      excluded: false,
      miles: iv.miles,
      months: iv.months,
    };
  }
  return overrides;
}

/** Slugifies a provider display name into a stable id ("BG Products" -> "bg-products"). */
export function providerIdFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
