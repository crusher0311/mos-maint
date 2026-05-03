export interface FuelTypeInputs {
  fuelType?: string | null;
  engineName?: string | null;
  engineInduction?: string | null;
  engineAspiration?: string | null;
  trim?: string | null;
  model?: string | null;
}

const SHORT_CODE_MAP: Record<string, string> = {
  G: "Gasoline",
  GAS: "Gasoline",
  GASOLINE: "Gasoline",
  D: "Diesel",
  DIESEL: "Diesel",
  E: "Electric",
  ELECTRIC: "Electric",
  EV: "Electric",
  BEV: "Electric",
  H: "Hybrid",
  HYBRID: "Hybrid",
  HEV: "Hybrid",
  PHEV: "Plug-in Hybrid",
  MHEV: "Mild Hybrid",
  F: "Flex Fuel",
  FLEX: "Flex Fuel",
  "FLEX FUEL": "Flex Fuel",
  FFV: "Flex Fuel",
  C: "CNG",
  CNG: "CNG",
  LPG: "LPG",
  PROPANE: "LPG",
  HYDROGEN: "Hydrogen",
  FCEV: "Hydrogen",
};

function normalize(s: string): string {
  return s.trim().toUpperCase();
}

function detectHybridFlavor(combined: string): "PHEV" | "MHEV" | "HEV" | null {
  const s = combined.toUpperCase();
  if (/PLUG[\s-]?IN/.test(s) || /\bPHEV\b/.test(s)) return "PHEV";
  if (/MILD[\s-]?HYBRID/.test(s) || /\bMHEV\b/.test(s) || /\b48[\s-]?V\b/.test(s)) return "MHEV";
  if (/\bHYBRID\b/.test(s) || /\bHEV\b/.test(s)) return "HEV";
  return null;
}

/**
 * Derive a human-readable fuel type label by combining the DataOne `fuel_type`
 * value with engine description / hybrid hints from the VIN decode. Falls back
 * to the raw value when nothing better can be inferred.
 */
export function deriveFuelTypeLabel(inputs: FuelTypeInputs): string | null {
  const raw = inputs.fuelType ?? null;
  const engineCombined = [
    inputs.engineName,
    inputs.engineInduction,
    inputs.engineAspiration,
    inputs.trim,
    inputs.model,
  ]
    .filter((v): v is string => Boolean(v))
    .join(" ");

  const rawNorm = raw ? normalize(raw) : "";
  const flavor = detectHybridFlavor(`${engineCombined} ${rawNorm}`);

  // Pure electric beats hybrid detection
  if (rawNorm === "E" || rawNorm === "ELECTRIC" || rawNorm === "EV" || rawNorm === "BEV") {
    return "Electric";
  }

  if (flavor === "PHEV") return "Plug-in Hybrid";
  if (flavor === "MHEV") return "Mild Hybrid";
  if (flavor === "HEV") return "Hybrid";

  // "I" is DataOne's "internal combustion" marker. Prefer engine-text hints
  // when they clearly indicate a non-gasoline ICE; otherwise treat "I" as
  // Gasoline, since that's what it means for the vast majority of decoded
  // VINs and the task explicitly asks us to stop showing the bare "I" code.
  if (rawNorm === "I") {
    if (/DIESEL/i.test(engineCombined)) return "Diesel";
    if (/FLEX/i.test(engineCombined)) return "Flex Fuel";
    if (/\bCNG\b/i.test(engineCombined)) return "CNG";
    if (/\bLPG\b|PROPANE/i.test(engineCombined)) return "LPG";
    return "Gasoline";
  }

  if (rawNorm && SHORT_CODE_MAP[rawNorm]) return SHORT_CODE_MAP[rawNorm];

  return raw && raw.trim() !== "" ? raw : null;
}
