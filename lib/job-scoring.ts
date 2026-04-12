export type ScoreBand = "exact" | "likely" | "possible" | "low_confidence";

export const STOPWORDS = new Set([
  "replace", "inspect", "check", "service", "repair", "install", "remove",
  "adjust", "flush", "bleed", "test", "clean", "lube", "lubricate", 
  "change", "perform", "complete", "top", "off", "the", "and", "for"
]);

export type GvwrBand = "light" | "medium" | "heavy";

export interface VehicleSpecs {
  gvwrBand: GvwrBand | null;
  bodyType: string | null;
  driveType: string | null;
  displacement: number | null;
  fuelType: string | null;
}

export interface VehicleContext {
  year?: string | number | null;
  make?: string | null;
  model?: string | null;
  engine?: string | null;
  vin?: string | null;
}

export interface ScoredJob {
  matchScore: number;
  matchBand: ScoreBand;
  matchBandLabel: string;
  matchReason: string;
  gatePass: boolean;
  lowConfidence: boolean;
  crossClassPenalized: boolean;
  scoreBreakdown?: {
    gvwrClass: number;
    bodyStyle: number;
    model: number;
    make: number;
    displacement: number;
    driveType: number;
    year: number;
    serviceCategory: number;
    crossClassMultiplier: number;
  };
  [key: string]: any;
}

export function parseGvwrBand(gvwrRange: string | null | undefined): GvwrBand | null {
  if (!gvwrRange) return null;
  const upper = gvwrRange.toUpperCase();
  const lbsMatch = upper.match(/([\d,]+)\s*(?:LBS?|POUNDS?)/);
  if (lbsMatch) {
    const weight = parseInt(lbsMatch[1].replace(/,/g, ''));
    if (weight <= 10000) return "light";
    if (weight <= 16000) return "medium";
    return "heavy";
  }
  if (/CLASS\s*[12]\b/.test(upper)) return "light";
  if (/CLASS\s*[34]\b/.test(upper)) return "medium";
  if (/CLASS\s*[5-8]\b/.test(upper)) return "heavy";
  return null;
}

export function inferGvwrBandFromModel(make: string | null, model: string | null): GvwrBand | null {
  if (!model) return null;
  const m = model.toUpperCase();
  const mk = (make || '').toUpperCase();
  if (/F[-\s]?[4-9]50|F[-\s]?[5-9]50|F[-\s]?[6-9]50|SUPER\s*DUTY|SILVERADO\s*[3-6]500|RAM\s*[3-6]500|KODIAK|TOPKICK|C[4-8]500|INTERNATIONAL|HINO|FREIGHTLINER|KENWORTH|PETERBILT/i.test(m)) return "heavy";
  if (/F[-\s]?[23]50|SILVERADO\s*2500|RAM\s*2500|SIERRA\s*2500|RANGER|TACOMA|COLORADO|CANYON|FRONTIER|MAVERICK|SANTA\s*CRUZ/i.test(m)) return "medium";
  if (/TRANSIT|SPRINTER|PROMASTER|E[-\s]?[23]50|EXPRESS|SAVANA|NV\s*[23]500/i.test(m)) return "medium";
  if (/F[-\s]?150|SILVERADO(?:\s*1500)?$|SIERRA(?:\s*1500)?$|RAM\s*1500|TUNDRA|TITAN/i.test(m)) return "light";
  if (/CIVIC|ACCORD|CAMRY|COROLLA|ALTIMA|SENTRA|FOCUS|FUSION|MALIBU|CRUZE|JETTA|GOLF|ELANTRA|SONATA|FORTE|OPTIMA|MAZDA|IMPREZA|LEGACY|PRIUS|VERSA|FIT|FIESTA|YARIS|MIATA|MUSTANG|CHARGER|CHALLENGER|CAMARO|MODEL\s*[3SXY]/i.test(m)) return "light";
  if (/EXPLORER|ESCAPE|RAV4|CR[-\s]?V|HIGHLANDER|PILOT|PATHFINDER|4RUNNER|WRANGLER|CHEROKEE|EQUINOX|TRAVERSE|TAHOE|SUBURBAN|EXPEDITION|DURANGO|SEQUOIA|LAND\s*CRUISER|BRONCO|EDGE|FLEX|TERRAIN|ACADIA|TUCSON|SANTA\s*FE|SORENTO|SPORTAGE|OUTBACK|FORESTER|ROGUE|MURANO|ARMADA|TELLURIDE|PALISADE|ATLAS/i.test(m)) return "light";
  return null;
}

const BODY_TYPE_GROUPS: Record<string, string[]> = {
  sedan: ["sedan", "coupe", "convertible", "hatchback", "liftback"],
  suv: ["suv", "sport utility", "crossover", "cuv", "wagon"],
  pickup: ["pickup", "crew cab", "extended cab", "regular cab", "double cab", "king cab"],
  van: ["van", "minivan", "cargo van", "passenger van"],
  commercial: ["cab chassis", "cab/chassis", "cutaway", "stripped chassis", "chassis cab"],
};

function normalizeBodyGroup(bodyType: string | null | undefined): string | null {
  if (!bodyType) return null;
  const lower = bodyType.toLowerCase();
  for (const [group, keywords] of Object.entries(BODY_TYPE_GROUPS)) {
    if (keywords.some(kw => lower.includes(kw))) return group;
  }
  return lower;
}

const SERVICE_CATEGORIES: Record<string, string[]> = {
  tire: ["tire", "rotation", "balance", "alignment", "wheel", "rim", "tpms"],
  brake: ["brake", "rotor", "caliper", "pad", "drum", "shoe"],
  engine: ["engine", "motor", "valve", "gasket", "timing", "piston", "cylinder head", "head gasket"],
  electrical: ["battery", "alternator", "starter", "wiring", "fuse", "light", "bulb", "ignition"],
  hvac: ["a/c", "air conditioning", "heater", "compressor", "evaporator", "refrigerant", "freon", "blower"],
  suspension: ["suspension", "shock", "strut", "spring", "control arm", "ball joint", "tie rod", "sway bar", "bushing"],
  exhaust: ["exhaust", "muffler", "catalytic", "converter", "manifold", "o2 sensor", "oxygen sensor"],
  transmission: ["transmission", "trans fluid", "clutch", "differential", "transfer case", "axle", "cv joint", "cv axle"],
  cooling: ["coolant", "radiator", "thermostat", "water pump", "cooling"],
  fluids: ["oil change", "oil filter", "fluid", "atf", "power steering fluid", "brake fluid"],
  steering: ["steering", "power steering", "rack", "steering pump", "tie rod"],
  diagnostic: ["diagnostic", "scan", "code", "dtc", "check engine"],
  maintenance: ["tune up", "spark plug", "wiper", "cabin filter", "air filter", "serpentine", "belt"],
};

function getServiceCategory(title: string | null | undefined): string | null {
  if (!title) return null;
  const lower = title.toLowerCase();
  for (const [category, keywords] of Object.entries(SERVICE_CATEGORIES)) {
    if (keywords.some(kw => lower.includes(kw))) return category;
  }
  return null;
}

export function getScoreBand(score: number): ScoreBand {
  if (score >= 85) return "exact";
  if (score >= 60) return "likely";
  if (score >= 35) return "possible";
  return "low_confidence";
}

export function getBandLabel(band: ScoreBand): string {
  switch (band) {
    case "exact": return "Exact Fit";
    case "likely": return "Great Match";
    case "possible": return "Good Match";
    case "low_confidence": return "Low Confidence";
  }
}

export function extractVehicleSpecs(decoded: any): VehicleSpecs {
  let displacement: number | null = null;
  if (decoded.engine_size && typeof decoded.engine_size === 'number' && decoded.engine_size > 0) {
    displacement = decoded.engine_size;
  }

  let fuelType: string | null = null;
  if (decoded.fuel_type) {
    const ft = decoded.fuel_type.toUpperCase();
    if (ft === 'D' || ft.includes('DIESEL')) fuelType = 'diesel';
    else if (ft === 'E' || ft.includes('ELECTRIC')) fuelType = 'electric';
    else if (ft.includes('HYBRID')) fuelType = 'hybrid';
    else fuelType = 'gas';
  }

  return {
    gvwrBand: parseGvwrBand(decoded.gross_vehicle_weight_range),
    bodyType: decoded.body_type || null,
    driveType: decoded.drive_type || null,
    displacement,
    fuelType,
  };
}

export function scoreJob(
  job: any, 
  targetVehicle: VehicleContext, 
  targetSpecs: VehicleSpecs | null,
  jobSpecs: VehicleSpecs | null,
  searchQuery?: string | null
): ScoredJob {
  const matchDetails: string[] = [];
  const targetYear = targetVehicle.year ? parseInt(String(targetVehicle.year)) : null;
  const vehicleMake = targetVehicle.make;
  const vehicleModel = targetVehicle.model;
  const jobYear = job.vehicle?.year ? parseInt(String(job.vehicle.year)) : null;

  const tFuel = targetSpecs?.fuelType || parseSimpleFuel(targetVehicle.engine);
  const jFuel = jobSpecs?.fuelType || parseSimpleFuel(job.vehicle?.engine);
  if (tFuel && jFuel && tFuel !== jFuel) {
    if ((tFuel === "diesel" || jFuel === "diesel") && tFuel !== jFuel) {
      return {
        ...job,
        matchScore: 0,
        matchBand: "low_confidence" as ScoreBand,
        matchBandLabel: "Failed Gate",
        matchReason: `Fuel mismatch (${tFuel} vs ${jFuel})`,
        gatePass: false,
        lowConfidence: true,
        crossClassPenalized: false,
      };
    }
  }

  const tGvwr = targetSpecs?.gvwrBand || inferGvwrBandFromModel(vehicleMake || null, vehicleModel || null);
  const jGvwr = jobSpecs?.gvwrBand || inferGvwrBandFromModel(job.vehicle?.make || null, job.vehicle?.model || null);

  let gvwrScore = 0;
  let gvwrMatch = false;
  if (tGvwr && jGvwr) {
    if (tGvwr === jGvwr) {
      gvwrScore = 25;
      gvwrMatch = true;
      matchDetails.push(`Same vehicle class (${tGvwr})`);
    } else {
      matchDetails.push(`Class mismatch (${tGvwr} vs ${jGvwr})`);
    }
  }

  const tBodyGroup = normalizeBodyGroup(targetSpecs?.bodyType);
  const jBodyGroup = normalizeBodyGroup(jobSpecs?.bodyType);
  let bodyScore = 0;
  if (tBodyGroup && jBodyGroup) {
    if (tBodyGroup === jBodyGroup) {
      bodyScore = 20;
      matchDetails.push("Same body style");
    }
  }

  const targetModelLower = vehicleModel?.toLowerCase() || "";
  const jobModelLower = job.vehicle?.model?.toLowerCase() || "";
  let modelScore = 0;
  if (targetModelLower && jobModelLower) {
    if (targetModelLower === jobModelLower) {
      modelScore = 20;
      matchDetails.push("Same model");
    } else if (targetModelLower.includes(jobModelLower) || jobModelLower.includes(targetModelLower)) {
      modelScore = 12;
      matchDetails.push("Model family match");
    }
  }

  const targetMakeLower = vehicleMake?.toLowerCase() || "";
  const jobMakeLower = job.vehicle?.make?.toLowerCase() || "";
  let makeScore = 0;
  if (targetMakeLower && jobMakeLower && targetMakeLower === jobMakeLower) {
    if (gvwrMatch) {
      makeScore = 10;
      matchDetails.push("Same make");
    } else if (!tGvwr && !jGvwr) {
      makeScore = 5;
      matchDetails.push("Same make (class unknown)");
    } else if (!tGvwr || !jGvwr) {
      makeScore = 3;
      matchDetails.push("Same make (partial class data)");
    } else {
      matchDetails.push("Same make (cross-class, no credit)");
    }
  }

  const tDisp = targetSpecs?.displacement || parseDisplacementFromEngine(targetVehicle.engine);
  const jDisp = jobSpecs?.displacement || parseDisplacementFromEngine(job.vehicle?.engine);
  let displacementScore = 0;
  if (tDisp && jDisp) {
    const diff = Math.abs(tDisp - jDisp);
    if (diff <= 0.5) {
      displacementScore = 15;
      matchDetails.push(`Engine displacement match (${jDisp}L)`);
    } else if (diff <= 1.5) {
      displacementScore = 8;
      matchDetails.push(`Similar displacement (${jDisp}L)`);
    }
  }

  const tDrive = (targetSpecs?.driveType || '').toUpperCase();
  const jDrive = (jobSpecs?.driveType || '').toUpperCase();
  let driveScore = 0;
  if (tDrive && jDrive) {
    if (tDrive === jDrive) {
      driveScore = 10;
      matchDetails.push("Same drive type");
    } else if (
      (tDrive.includes('AWD') && jDrive.includes('4WD')) ||
      (tDrive.includes('4WD') && jDrive.includes('AWD'))
    ) {
      driveScore = 7;
      matchDetails.push("Similar drive type");
    }
  }

  let yearScore = 0;
  if (targetYear && jobYear) {
    const yearDiff = Math.abs(targetYear - jobYear);
    if (yearDiff <= 2) {
      yearScore = 10;
      matchDetails.push(yearDiff === 0 ? "Exact year" : `${yearDiff} year${yearDiff > 1 ? 's' : ''} off`);
    } else if (yearDiff <= 5) {
      yearScore = 5;
      matchDetails.push(`${yearDiff} years off`);
    } else {
      matchDetails.push(`${yearDiff} years off`);
    }
  }

  const jobTitle = job.job?.title || job.title || '';
  const jobCategory = getServiceCategory(jobTitle);
  const queryCategory = searchQuery ? getServiceCategory(searchQuery) : null;
  let categoryScore = 0;
  if (queryCategory && jobCategory) {
    if (queryCategory === jobCategory) {
      categoryScore = 15;
      matchDetails.push(`Service category match (${jobCategory})`);
    }
  } else if (jobCategory) {
    categoryScore = 5;
  }

  let rawScore = gvwrScore + bodyScore + modelScore + makeScore + displacementScore + driveScore + yearScore + categoryScore;

  let crossClassMultiplier = 1.0;
  let crossClassPenalized = false;
  if (tGvwr && jGvwr && tGvwr !== jGvwr) {
    crossClassMultiplier = 0.2;
    crossClassPenalized = true;
    rawScore = Math.round(rawScore * crossClassMultiplier);
  }

  const finalScore = Math.max(0, Math.min(100, rawScore));
  const band = getScoreBand(finalScore);

  return {
    ...job,
    matchScore: finalScore,
    matchBand: band,
    matchBandLabel: getBandLabel(band),
    matchReason: matchDetails.join(" | ") || "Keyword match",
    gatePass: true,
    lowConfidence: band === "low_confidence",
    crossClassPenalized,
    scoreBreakdown: {
      gvwrClass: gvwrScore,
      bodyStyle: bodyScore,
      model: modelScore,
      make: makeScore,
      displacement: displacementScore,
      driveType: driveScore,
      year: yearScore,
      serviceCategory: categoryScore,
      crossClassMultiplier,
    },
  };
}

function parseSimpleFuel(engine: string | null | undefined): string | null {
  if (!engine) return null;
  const upper = engine.toUpperCase();
  if (/DIESEL|TDI|DURAMAX|POWERSTROKE|CUMMINS/.test(upper)) return "diesel";
  if (/HYBRID|HEV|PHEV/.test(upper)) return "hybrid";
  if (/ELECTRIC|EV|BATTERY/.test(upper)) return "electric";
  return "gas";
}

function parseDisplacementFromEngine(engine: string | null | undefined): number | null {
  if (!engine) return null;
  const upper = engine.toUpperCase();
  const literMatch = upper.match(/(\d+\.?\d*)\s*L(?:ITER)?/);
  if (literMatch) return parseFloat(literMatch[1]);
  const ccMatch = upper.match(/(\d{3,4})\s*CC/);
  if (ccMatch) return parseInt(ccMatch[1]) / 1000;
  return null;
}

export function applyMinimumResults(
  scoredJobs: ScoredJob[], 
  minThreshold: number = 15, 
  minResults: number = 3
): ScoredJob[] {
  const aboveThreshold = scoredJobs.filter(j => j.gatePass && j.matchScore >= minThreshold);
  
  if (aboveThreshold.length >= minResults) {
    return aboveThreshold;
  }

  const allPassing = scoredJobs
    .filter(j => j.gatePass)
    .sort((a, b) => b.matchScore - a.matchScore);
  
  const results: ScoredJob[] = [];
  for (const job of allPassing) {
    if (job.matchScore >= minThreshold) {
      results.push(job);
    } else if (results.length < minResults) {
      results.push({ ...job, lowConfidence: true, matchBand: "low_confidence", matchBandLabel: "Low Confidence" });
    }
  }
  
  return results;
}

export function buildSearchQuery(query: string): { coreTokens: string[]; allTokens: string[] } {
  const allTokens = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const coreTokens = allTokens.filter(w => !STOPWORDS.has(w));
  return { coreTokens, allTokens };
}
