export type AcesTier = "exact_aces" | "engine_match" | "submodel_match" | null | undefined;

/**
 * A single plain-language confidence badge shown to service advisors next to
 * the numeric match percentage. Advisors don't know what "ACES" means, so the
 * label describes how trustworthy the match is in plain words — the precise
 * score stays visible beside it for power users.
 */
export interface MatchConfidenceBadge {
  label: string;
  tooltip: string;
  /** Tailwind classes for the badge pill. Green → teal → blue → gray ramp. */
  className: string;
}

/**
 * Everything the badge needs to pick one consistent label. All fields are
 * optional so callers can pass whatever the scorer surfaced — a missing field
 * just means "that tier didn't fire."
 */
export interface MatchConfidenceInput {
  /** Donor job was performed on the same physical VIN (top tier). */
  sameVinFastPath?: boolean | null;
  /** Which ACES tier the scorer fired, or null for the heuristic fallback. */
  acesTier?: AcesTier;
  /**
   * Whether the donor passed the safety gate. When false (e.g. diesel vs gas
   * on a powertrain job) it must read as "Not a match", never a generic match.
   */
  gatePass?: boolean | null;
}

/**
 * Map a scored job to one plain-language confidence label, color, and tooltip.
 *
 * Tiers (highest → lowest confidence):
 *   - same VIN                    → "VIN Match"                     (green)
 *   - exact ACES vehicle config   → "Verified match"               (green)
 *   - same engine (powertrain)    → "Strong match"                 (teal)
 *   - same chassis (chassis work) → "Strong match"                 (teal)
 *   - heuristic YMM-only fallback → "General match"                (blue)
 *   - safety-gate fail            → "Not a match"                  (gray)
 *
 * The word "ACES" never appears in any user-facing string here.
 */
export function getMatchConfidenceBadge(input: MatchConfidenceInput): MatchConfidenceBadge {
  const { sameVinFastPath, acesTier, gatePass } = input;

  // Hard safety-gate failure — never let this read as a generic match.
  if (gatePass === false) {
    return {
      label: "Not a match",
      tooltip:
        "Different powertrain (for example diesel vs gas) — not a safe match for this vehicle.",
      className: "bg-gray-100 text-gray-600 border-gray-300",
    };
  }

  // Top tier — the vehicle's own past work (same VIN).
  if (sameVinFastPath) {
    return {
      label: "VIN Match",
      tooltip:
        "This job was performed on this exact vehicle (same VIN) — the most reliable match.",
      className: "bg-emerald-100 text-emerald-800 border-emerald-300",
    };
  }

  switch (acesTier) {
    case "exact_aces":
      return {
        label: "Verified match",
        tooltip:
          "Same year, make, model, trim, and engine as this vehicle — parts and labor should line up.",
        className: "bg-emerald-100 text-emerald-800 border-emerald-300",
      };
    case "engine_match":
      return {
        label: "Strong match",
        tooltip:
          "Same engine in a different model — reliable for engine, oil, cooling, fuel, and exhaust work.",
        className: "bg-teal-100 text-teal-800 border-teal-300",
      };
    case "submodel_match":
      return {
        label: "Strong match",
        tooltip:
          "Same body/chassis with a different engine option — reliable for brakes, suspension, steering, and body work.",
        className: "bg-teal-100 text-teal-800 border-teal-300",
      };
    default:
      // Legacy heuristic fallback: matched on year/make/model only.
      return {
        label: "General match",
        tooltip:
          "Matched on year, make, and model. Parts and labor may vary by trim or engine.",
        className: "bg-blue-100 text-blue-700 border-blue-300",
      };
  }
}
