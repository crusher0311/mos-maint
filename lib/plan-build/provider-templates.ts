/**
 * Built-in chemical-provider schedule templates (Task #803 follow-on).
 *
 * Templates let a shop one-click a provider schedule instead of typing
 * every interval. The first template is BG's Lifetime Protection Plan
 * (LPP) per the 1-1-2021 certificate: service intervals required to stay
 * eligible, plus the plan-entry eligibility rules (vehicle age + entry
 * mileage bands) so the plan page can show whether a vehicle qualifies.
 *
 * All interval values are REAL MILES (the settings form converts to km
 * for display when the shop uses kilometers).
 *
 * This module is pure (no "server-only", no DB imports) so it can be
 * shared by the settings form (client), the dashboard plan page (server),
 * and unit tests under tsx.
 */

export interface ProviderTemplateInterval {
  miles: number | null;
  months: number | null;
}

export interface ProviderTemplate {
  templateId: string;
  /** Default provider display name. */
  name: string;
  /** Short description shown next to the quick-add button. */
  description: string;
  /** serviceKey (COMMON_SERVICES key) -> required service interval. */
  intervals: Record<string, ProviderTemplateInterval>;
}

/**
 * BG Lifetime Protection Plan required service intervals (gasoline
 * cadence; BG's diesel engine-service cadence is 7,500 mi — shops can
 * edit the prefilled value if they mostly service diesels).
 */
export const BG_LPP_TEMPLATE: ProviderTemplate = {
  templateId: "bg-lpp",
  name: "BG Protection Plan",
  description:
    "BG Lifetime Protection Plan service intervals (engine 10,000 mi gasoline / 7,500 mi diesel, fuel 15,000 mi, driveline & fluid services 30,000 mi).",
  intervals: {
    // ENGINE SERVICES — 10,000 mi gasoline (7,500 diesel; 12,500 w/ BG oil).
    oil: { miles: 10000, months: null },
    // FUEL SYSTEM SERVICE — 15,000 mi.
    fuel_system: { miles: 15000, months: null },
    // AUTOMOTIVE MAINTENANCE SERVICES — 30,000 mi.
    trans_auto: { miles: 30000, months: null },
    trans_manual: { miles: 30000, months: null },
    coolant: { miles: 30000, months: null },
    power_steering: { miles: 30000, months: null },
    brake_fluid: { miles: 30000, months: null },
    front_differential: { miles: 30000, months: null },
    rear_differential: { miles: 30000, months: null },
    transfer_case: { miles: 30000, months: null },
  },
};

export const PROVIDER_TEMPLATES: ProviderTemplate[] = [BG_LPP_TEMPLATE];

export function getProviderTemplate(templateId: string | null | undefined): ProviderTemplate | null {
  if (!templateId) return null;
  return PROVIDER_TEMPLATES.find((t) => t.templateId === templateId) ?? null;
}

/* ------------------------------------------------------------------ */
/* BG LPP plan-entry eligibility                                       */
/* ------------------------------------------------------------------ */

export interface BgLppEligibility {
  /** "eligible" | "ineligible" | "unknown" */
  status: "eligible" | "ineligible" | "unknown";
  /** e.g. "Plan 1" / "Plan 2" / "Plan 2 (gasoline only)"; null unless eligible. */
  planLabel: string | null;
  /** Human-readable explanation for the badge tooltip/body text. */
  detail: string;
}

/** Max vehicle age (years) at time of initial service to enter the plan. */
export const BG_LPP_MAX_VEHICLE_AGE_YEARS = 20;
/** Entry-mileage bands (miles). */
export const BG_LPP_PLAN1_MAX_MILES = 50000;
export const BG_LPP_PLAN2_MAX_MILES = 75000;
export const BG_LPP_PLAN2_GAS_MAX_MILES = 125000;

/**
 * Evaluates whether a vehicle can ENTER the BG Lifetime Protection Plan
 * today, per the certificate's entry rules:
 * - vehicle no more than 20 years old at the initial service
 * - Plan 1: 0–50,000 mi | Plan 2: 50,001–75,000 mi
 * - Plan 2 gasoline only: 75,001–125,000 mi
 *
 * Fuel type is not reliably known here, so the 75k–125k band is labeled
 * "gasoline only" rather than hard-refused for diesels.
 */
export function evaluateBgLppEligibility(
  vehicleYear: number | null | undefined,
  currentMiles: number | null | undefined,
  now: Date = new Date()
): BgLppEligibility {
  if (vehicleYear == null && currentMiles == null) {
    return {
      status: "unknown",
      planLabel: null,
      detail: "Vehicle year and mileage are needed to check BG plan eligibility.",
    };
  }

  const age = vehicleYear != null ? now.getFullYear() - vehicleYear : null;
  if (age != null && age > BG_LPP_MAX_VEHICLE_AGE_YEARS) {
    return {
      status: "ineligible",
      planLabel: null,
      detail: `Vehicle is ~${age} years old — must be no more than ${BG_LPP_MAX_VEHICLE_AGE_YEARS} years old at the initial BG service.`,
    };
  }

  if (currentMiles == null) {
    return {
      status: "unknown",
      planLabel: null,
      detail: "Current mileage is needed to determine the entry plan (Plan 1 vs Plan 2).",
    };
  }

  if (currentMiles <= BG_LPP_PLAN1_MAX_MILES) {
    return {
      status: "eligible",
      planLabel: "Plan 1",
      detail: `Entered at ${BG_LPP_PLAN1_MAX_MILES.toLocaleString()} miles or less — highest coverage tier (up to $6,000 engine coverage).`,
    };
  }
  if (currentMiles <= BG_LPP_PLAN2_MAX_MILES) {
    return {
      status: "eligible",
      planLabel: "Plan 2",
      detail: `Entry between ${(BG_LPP_PLAN1_MAX_MILES + 1).toLocaleString()} and ${BG_LPP_PLAN2_MAX_MILES.toLocaleString()} miles (up to $3,000 engine coverage). Takes effect 1,000 miles after the first BG service.`,
    };
  }
  if (currentMiles <= BG_LPP_PLAN2_GAS_MAX_MILES) {
    return {
      status: "eligible",
      planLabel: "Plan 2 (gasoline only)",
      detail: `Gasoline engines may enter between ${(BG_LPP_PLAN2_MAX_MILES + 1).toLocaleString()} and ${BG_LPP_PLAN2_GAS_MAX_MILES.toLocaleString()} miles via the Dynamic Engine Restoration entry service.`,
    };
  }
  return {
    status: "ineligible",
    planLabel: null,
    detail: `Over ${BG_LPP_PLAN2_GAS_MAX_MILES.toLocaleString()} miles — beyond the maximum entry mileage for the BG Lifetime Protection Plan.`,
  };
}
