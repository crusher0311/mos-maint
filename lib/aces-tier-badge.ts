export type AcesTier = "exact_aces" | "engine_match" | "submodel_match" | null | undefined;

export interface AcesTierBadge {
  label: string;
  tooltip: string;
  className: string;
}

export function getAcesTierBadge(tier: AcesTier): AcesTierBadge | null {
  switch (tier) {
    case "exact_aces":
      return {
        label: "Exact fit",
        tooltip:
          "Exact ACES match — same year, make, model, submodel, and engine as the target vehicle.",
        className: "bg-emerald-100 text-emerald-800 border-emerald-300",
      };
    case "engine_match":
      return {
        label: "Same engine",
        tooltip:
          "Same engine in a different chassis — strong match for engine, oil, cooling, fuel, and exhaust work.",
        className: "bg-sky-100 text-sky-800 border-sky-300",
      };
    case "submodel_match":
      return {
        label: "Same chassis",
        tooltip:
          "Same chassis with a different engine option — strong match for body, brakes, suspension, steering, and wheel/tire work.",
        className: "bg-violet-100 text-violet-800 border-violet-300",
      };
    default:
      return null;
  }
}
