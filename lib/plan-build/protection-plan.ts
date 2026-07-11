/**
 * Task #804: Protection-plan enrollment status, eligibility detection and
 * lapse-risk computation for chemical-provider plans (e.g. BG Lifetime
 * Protection Plan).
 *
 * Pure module (no "server-only", no DB imports) so it can be unit-tested
 * under tsx and shared by the dashboard plan page, the enrollment API and
 * the shop roster report.
 *
 * Three independent signals, combined into one badge status:
 *  - enrolled: an enrollment record exists for (shop, VIN, provider).
 *  - at risk:  enrolled AND a service required by the provider's schedule
 *              (a key in `provider.intervals`) sits in the provider
 *              variant's OVERDUE bucket. A warning only — never an
 *              automatic un-enrollment.
 *  - eligible: NOT enrolled AND the vehicle's shop service history
 *              contains provider-branded jobs (brand-token match on the
 *              job name, e.g. "BG EPR Engine Performance Restoration").
 *
 * Eligibility rules are intentionally simple and adjustable: brand tokens
 * are derived from the provider display name + templateId, with generic
 * words filtered out (see GENERIC_PROVIDER_WORDS).
 */

import type { ChemicalProvider } from "@/lib/plan-build/chemical-providers";

/** Words in a provider name that never work as history-matching tokens. */
export const GENERIC_PROVIDER_WORDS = new Set([
  "products",
  "product",
  "protection",
  "plan",
  "plans",
  "plus",
  "chemical",
  "chemicals",
  "the",
  "co",
  "inc",
  "llc",
  "company",
  "auto",
  "automotive",
  "service",
  "services",
  "lifetime",
]);

/**
 * Brand tokens used to spot provider-branded jobs in service history.
 * "BG" -> ["bg"]; "BG Products" -> ["bg"]; templateId "bg-lpp" also
 * contributes its leading segment ("bg"). Tokens are lowercase and
 * matched on word boundaries so "bg" never matches inside "bag".
 */
export function getProviderBrandTokens(provider: {
  name: string;
  templateId?: string | null;
}): string[] {
  const tokens = new Set<string>();
  for (const word of provider.name.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!word || word.length < 2) continue;
    if (GENERIC_PROVIDER_WORDS.has(word)) continue;
    tokens.add(word);
  }
  const tpl = (provider.templateId || "").toLowerCase();
  const tplLead = tpl.split("-")[0];
  if (tplLead && tplLead.length >= 2 && !GENERIC_PROVIDER_WORDS.has(tplLead)) {
    tokens.add(tplLead);
  }
  return Array.from(tokens);
}

/** True when a service/job name contains one of the brand tokens as a whole word. */
export function serviceNameMatchesBrand(name: string, tokens: string[]): boolean {
  if (!name || tokens.length === 0) return false;
  const lower = name.toLowerCase();
  for (const token of tokens) {
    const re = new RegExp(`(^|[^a-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);
    if (re.test(lower)) return true;
  }
  return false;
}

export interface ProviderEligibility {
  eligible: boolean;
  /** Distinct history job names that matched the provider brand. */
  matches: string[];
}

/**
 * Eligibility detection: the vehicle has had qualifying (provider-branded)
 * services in its history but may not be enrolled yet.
 */
export function detectProviderEligibility(
  provider: { name: string; templateId?: string | null },
  historyServiceNames: string[],
): ProviderEligibility {
  const tokens = getProviderBrandTokens(provider);
  const matches: string[] = [];
  const seen = new Set<string>();
  for (const name of historyServiceNames) {
    if (!name) continue;
    const norm = name.trim();
    const dedupeKey = norm.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    if (serviceNameMatchesBrand(norm, tokens)) {
      seen.add(dedupeKey);
      matches.push(norm);
    }
  }
  return { eligible: matches.length > 0, matches };
}

export interface LapseRiskItem {
  serviceKey: string;
  title: string;
}

export interface LapseRisk {
  atRisk: boolean;
  /** Provider-required services currently overdue under the provider plan. */
  overdueRequired: LapseRiskItem[];
}

/**
 * Lapse-risk: services the provider's schedule requires (keys present in
 * `provider.intervals`) that are OVERDUE in the provider plan variant.
 * Callers pass the overdue bucket of the `provider:<id>` variant.
 */
export function computeLapseRisk(
  provider: Pick<ChemicalProvider, "intervals">,
  overdueItems: Array<{ serviceKey?: string | null; title?: string | null }>,
): LapseRisk {
  const requiredKeys = new Set(Object.keys(provider.intervals || {}));
  const overdueRequired: LapseRiskItem[] = [];
  const seen = new Set<string>();
  for (const item of overdueItems || []) {
    const key = item?.serviceKey || "";
    if (!key || !requiredKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    overdueRequired.push({ serviceKey: key, title: item?.title || key });
  }
  return { atRisk: overdueRequired.length > 0, overdueRequired };
}

export type ProtectionPlanStatus = "enrolled" | "at_risk" | "eligible" | "none";

/**
 * Combined badge status. At-risk only applies to enrolled vehicles;
 * eligibility only applies to non-enrolled vehicles.
 */
export function resolveProtectionPlanStatus(args: {
  enrolled: boolean;
  atRisk: boolean;
  eligible: boolean;
}): ProtectionPlanStatus {
  if (args.enrolled) return args.atRisk ? "at_risk" : "enrolled";
  return args.eligible ? "eligible" : "none";
}
