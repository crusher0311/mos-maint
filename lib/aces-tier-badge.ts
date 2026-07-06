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
  /**
   * The final match score (0-100). Used to pick the plain-language label for
   * heuristic / sibling matches so the web app reads identically to the
   * extension's confidence ladder. When absent, we fall back to "Likely Match".
   */
  score?: number | null;
}

// Ladder thresholds — kept in sync with lib/job-scoring.ts.
const LIKELY_FIT_MIN = 80; // unconfirmed heuristic near-exact
const LIKELY_MATCH_MIN = 55; // strong related / sibling
const GOOD_MATCH_MIN = 35;

/**
 * Map a scored job to one plain-language confidence label, color, and tooltip.
 * The vocabulary matches the extension exactly (highest → lowest confidence):
 *
 *   - same VIN                    → "VIN Match"      (100, green)
 *   - exact ACES vehicle config   → "Exact Fit"     (95,  green)
 *   - heuristic near-exact        → "Likely Fit"    (80+, teal)
 *   - sibling / strong related    → "Likely Match"  (55+, blue)
 *   - looser match                → "Good Match"    (35+, slate)
 *   - weak                        → "Low Confidence"(<35, gray)
 *   - safety-gate fail            → "Not a match"   (gray)
 *
 * The word "ACES" never appears in any user-facing string here.
 */
export function getMatchConfidenceBadge(input: MatchConfidenceInput): MatchConfidenceBadge {
  const { sameVinFastPath, acesTier, gatePass, score } = input;

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

  // Catalog-confirmed identical spec on a different car.
  if (acesTier === "exact_aces") {
    return {
      label: "Exact Fit",
      tooltip:
        "Same year, make, model, trim, and engine as this vehicle — parts and labor should line up.",
      className: "bg-emerald-100 text-emerald-800 border-emerald-300",
    };
  }

  // Everything else — siblings and heuristic matches. The label comes from the
  // score ladder so it reads identically to the extension; the tooltip is
  // enriched by the ACES sibling tier when we know it.
  let tooltip =
    "Matched on year, make, and model. Parts and labor may vary by trim or engine.";
  if (acesTier === "engine_match") {
    tooltip =
      "Same engine in a different model — reliable for engine, oil, cooling, fuel, and exhaust work.";
  } else if (acesTier === "submodel_match") {
    tooltip =
      "Same body/chassis with a different engine option — reliable for brakes, suspension, steering, and body work.";
  }

  const s = typeof score === "number" ? score : null;

  if (s !== null && s >= LIKELY_FIT_MIN) {
    return { label: "Likely Fit", tooltip, className: "bg-teal-100 text-teal-800 border-teal-300" };
  }
  if (s === null || s >= LIKELY_MATCH_MIN) {
    return { label: "Likely Match", tooltip, className: "bg-blue-100 text-blue-700 border-blue-300" };
  }
  if (s >= GOOD_MATCH_MIN) {
    return { label: "Good Match", tooltip, className: "bg-slate-100 text-slate-700 border-slate-300" };
  }
  return { label: "Low Confidence", tooltip, className: "bg-gray-100 text-gray-600 border-gray-300" };
}
