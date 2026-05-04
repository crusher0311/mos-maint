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

/**
 * Optional per-call context for `scoreJob`. Used to add small "supporting
 * evidence" bonuses that the Apr 12 rewrite dropped (Task #182). All fields
 * are optional and the scorer must still work when this is omitted (existing
 * callers pass 5 args).
 */
export interface ScoreOptions {
  /** The shop the advisor is searching from. Same-shop donors get a small bonus. */
  currentShopId?: number | string | null;
  /** Number of other donor jobs that corroborate this one (same canned title / category). */
  corroboratingCount?: number;
  /** Override "now" for testing the recency bonus. */
  now?: Date;
}

/**
 * Vehicle system the donor job operated on (Task #364).
 *
 * The matcher uses this to pick a per-category weight profile so chassis /
 * brake / suspension / HVAC / body work isn't penalized for engine
 * differences the way powertrain work legitimately should be.
 */
export type VehicleSystem =
  | "powertrain"
  | "suspension"
  | "brakes"
  | "steering"
  | "hvac"
  | "body"
  | "electrical"
  | "wheel_tire"
  | "general";

export interface ScoredJob {
  matchScore: number;
  matchBand: ScoreBand;
  matchBandLabel: string;
  matchReason: string;
  gatePass: boolean;
  lowConfidence: boolean;
  crossClassPenalized: boolean;
  sameVinFastPath?: boolean;
  /** Inferred vehicle-system category for this donor job (Task #364). */
  vehicleSystem?: VehicleSystem;
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
    /** Recency / same-shop / corroboration evidence (Task #182). */
    evidenceBonus: number;
    /** Category-aware profile applied to this match (Task #364). */
    vehicleSystem: VehicleSystem;
    /**
     * Whether the engine signals (displacement, fuel) were considered.
     * False for chassis / HVAC / body / wheel-tire / electrical work where
     * engine differences shouldn't penalize an otherwise relevant match.
     */
    engineSignalsApplied: boolean;
    /**
     * Whether the diesel↔gas safety gate was active for this match.
     * Only enabled for powertrain (and unclassified "general") jobs.
     */
    fuelGateApplied: boolean;
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

/**
 * Vehicle-system keyword patterns (Task #364).
 *
 * Used to bucket a donor job into the system it actually touched, so the
 * scorer can pick weights appropriate to the work. Order matters — the
 * first pattern that matches wins. We intentionally check the more
 * chassis-y categories before "powertrain" because some keywords (e.g.
 * "tie rod", "cabin filter", "wheel bearing") would otherwise be swallowed
 * by powertrain's broad keyword set.
 *
 * The classifier is deliberately keyword-driven and conservative: when a
 * job title doesn't clearly indicate a system, we fall back to "general"
 * which preserves today's powertrain-equivalent behavior (full engine
 * weight, fuel safety gate on). That keeps the failure mode safe — an
 * unclassified job is scored exactly the way it is today.
 */
// Each pattern uses a leading `\b` for word-boundary safety but no trailing
// boundary, so plural forms ("ball joints", "spark plugs", "rotors") match
// the same as the singular. Order matters: more specific categories come
// first because some keywords (e.g. "tie rod") legitimately apply to more
// than one system.
const SYSTEM_PATTERNS: Array<[VehicleSystem, RegExp]> = [
  // Brakes — distinct enough to check first.
  ["brakes", /\b(brake|rotor|caliper|abs\b|master\s*cylinder|wheel\s*cylinder|parking\s*brake|emergency\s*brake|e[-\s]?brake)/i],
  // HVAC — must beat powertrain because "blower", "cabin filter" are HVAC.
  ["hvac", /\b(a\/c\b|air\s*conditioning|ac\s*compressor|heater|hvac\b|evaporator|condenser|blower\s*motor|cabin\s*filter|cabin\s*air\s*filter|refrigerant|freon|recharge|heater\s*core|expansion\s*valve|orifice\s*tube)/i],
  // Wheel & tire — alignment, TPMS, rotation, balancing.
  ["wheel_tire", /\b(tire|tyre|wheel(?!\s*cylinder|\s*bearing|\s*hub)|rim|tpms|rotation|balance|alignment|lug\s*nut|wheel\s*stud)/i],
  // Suspension — control arms, ball joints, struts, wheel bearings, CV.
  ["suspension", /\b(suspension|shock(?:\s*absorber)?|strut|coil\s*spring|leaf\s*spring|control\s*arm|upper\s*arm|lower\s*arm|ball\s*joint|sway\s*bar|stabilizer|bushing|air\s*ride|wheel\s*bearing|hub\s*assembly|cv\s*axle|cv\s*joint|knuckle)/i],
  // Steering — rack, pump, tie rod, idler/pitman.
  ["steering", /\b(steering|rack\s*(?:and|&)\s*pinion|power\s*steering|steering\s*pump|steering\s*rack|steering\s*column|steering\s*wheel|tie\s*rod|idler\s*arm|pitman\s*arm|steering\s*box)/i],
  // Body — doors, mirrors, glass, lighting, wipers, seats, airbags.
  ["body", /\b(door(?:\s*handle|\s*latch|\s*lock)?|window\s*regulator|window\s*motor|side\s*mirror|rear\s*view|bumper|fender|hood\s*latch|trunk|tailgate|liftgate|paint|trim|molding|weatherstrip|seat(?:\s*belt)?|upholstery|airbag|wiper|wiper\s*blade|washer\s*pump|washer\s*nozzle|headlight|headlamp|tail\s*light|tail\s*lamp|fog\s*light|turn\s*signal|interior\s*light)/i],
  // Electrical — battery / alternator / starter / wiring / sensors / modules.
  ["electrical", /\b(battery|batteries|alternator|starter|wiring|fuse|relay|harness|ignition\s*switch|key\s*fob|remote\s*start|ecm\b|pcm\b|tcm\b|bcm\b|body\s*control\s*module)/i],
  // Powertrain — engine, transmission, fuel, cooling, exhaust, oil work.
  ["powertrain", /\b(engine|motor(?!\s*mount)|valve(?!\s*stem)|head\s*gasket|gasket|timing|piston|cylinder\s*head|crankshaft|camshaft|turbo|intercooler|injector|fuel\s*pump|fuel\s*filter|fuel\s*rail|spark\s*plug|coil\s*pack|tune[-\s]*up|oil\s*change|oil\s*filter|oil\s*pan|valve\s*cover|intake\s*manifold|exhaust\s*manifold|catalytic|converter|muffler|exhaust|o2\s*sensor|oxygen\s*sensor|transmission|clutch|differential|transfer\s*case|axle\s*shaft|trans\s*fluid|atf\b|coolant|radiator|water\s*pump|cooling|thermostat(?!\s*housing)|head\s*bolt|serpentine|drive\s*belt|timing\s*belt|timing\s*chain)/i],
];

/**
 * Classify a donor job into a vehicle-system category from its title and
 * optional line-item descriptions. Returns "general" when no pattern
 * matches — that preserves today's powertrain-equivalent scoring as the
 * safe fallback for ambiguous canned-job titles.
 */
export function classifyVehicleSystem(
  title: string | null | undefined,
  lineItems?: Array<string | null | undefined> | null,
): VehicleSystem {
  const parts: string[] = [];
  if (title) parts.push(String(title));
  if (Array.isArray(lineItems)) {
    for (const li of lineItems) if (li) parts.push(String(li));
  }
  if (parts.length === 0) return "general";
  const haystack = parts.join(" \n ");
  for (const [system, re] of SYSTEM_PATTERNS) {
    if (re.test(haystack)) return system;
  }
  return "general";
}

interface CategoryProfile {
  /** Whether to add the displacement contribution and the
   *  "Different engine" material miss. */
  engineSignalsApplied: boolean;
  /** Whether the diesel↔gas hard-fail safety gate runs. */
  fuelGateApplied: boolean;
}

/**
 * Per-category scoring profile. Powertrain (and the safe-fallback
 * "general") preserve today's behavior so engine-relevant work is still
 * gated and weighted as it always has been. Chassis / HVAC / body /
 * wheel-tire / electrical drop the engine signal entirely so a 2018 F-150
 * ball joint match isn't penalized for the donor having a 2.7 EcoBoost
 * vs. the target's 5.0.
 */
const CATEGORY_PROFILES: Record<VehicleSystem, CategoryProfile> = {
  powertrain: { engineSignalsApplied: true, fuelGateApplied: true },
  general:    { engineSignalsApplied: true, fuelGateApplied: true },
  suspension: { engineSignalsApplied: false, fuelGateApplied: false },
  brakes:     { engineSignalsApplied: false, fuelGateApplied: false },
  steering:   { engineSignalsApplied: false, fuelGateApplied: false },
  wheel_tire: { engineSignalsApplied: false, fuelGateApplied: false },
  hvac:       { engineSignalsApplied: false, fuelGateApplied: false },
  body:       { engineSignalsApplied: false, fuelGateApplied: false },
  electrical: { engineSignalsApplied: false, fuelGateApplied: false },
};

export function getCategoryProfile(system: VehicleSystem): CategoryProfile {
  return CATEGORY_PROFILES[system];
}

/**
 * Band thresholds (Task #182 recalibration).
 *
 * Driven by the calibration dump in
 * `docs/job-match-calibration-2026-04-29.md`. With the Apr 12 algorithm a
 * same-VIN-class job routinely landed in the 60–75 range and Exact Fit had
 * effectively disappeared. The combination of (a) the same-VIN fast path,
 * (b) the same-make+model+engine ±1y floor, (c) restored evidence bonuses
 * (recency / same shop / corroboration) and (d) these slightly looser bands
 * is what brings the distribution back in line with advisor intuition.
 */
export const SCORE_THRESHOLD_EXACT = 80;
export const SCORE_THRESHOLD_LIKELY = 55;
export const SCORE_THRESHOLD_POSSIBLE = 35;

export function getScoreBand(score: number): ScoreBand {
  if (score >= SCORE_THRESHOLD_EXACT) return "exact";
  if (score >= SCORE_THRESHOLD_LIKELY) return "likely";
  if (score >= SCORE_THRESHOLD_POSSIBLE) return "possible";
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

/**
 * Normalize a VIN for the same-VIN fast-path comparison.
 *
 * Modern VINs are exactly 17 alphanumeric characters with no I/O/Q. We
 * intentionally reject anything shorter (e.g. squish-VIN fragments,
 * truncated entries) so a partial-VIN collision can never wrongly trip
 * the Exact Fit short-circuit.
 */
function normalizeVin(vin: unknown): string | null {
  if (typeof vin !== "string") return null;
  const trimmed = vin.trim().toUpperCase();
  if (trimmed.length !== 17) return null;
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Build the user-facing match-reason string.
 *
 * Task #182: lead with what *did* match ("Same model, same engine, 1 year off,
 * same shop") and only append misses when they're material (cross-class,
 * big year gap, missing displacement match on a same-model donor). Suppress
 * noise like "Same make (cross-class, no credit)" — that read as the system
 * arguing with itself.
 */
function buildMatchReason(positives: string[], materialMisses: string[]): string {
  const positiveText = positives.length ? positives.join(", ") : "Keyword match";
  if (!materialMisses.length) return positiveText;
  return `${positiveText} — ${materialMisses.join(", ")}`;
}

export function scoreJob(
  job: any,
  targetVehicle: VehicleContext,
  targetSpecs: VehicleSpecs | null,
  jobSpecs: VehicleSpecs | null,
  searchQuery?: string | null,
  options?: ScoreOptions,
): ScoredJob {
  const positives: string[] = [];
  const materialMisses: string[] = [];

  const targetYear = targetVehicle.year ? parseInt(String(targetVehicle.year)) : null;
  const vehicleMake = targetVehicle.make;
  const vehicleModel = targetVehicle.model;
  const jobYear = job.vehicle?.year ? parseInt(String(job.vehicle.year)) : null;

  // ----- Same-VIN fast path (Task #182) -----
  // If the donor job was performed on the *same VIN* as the target vehicle,
  // short-circuit to Exact Fit. This is the "missing decode data shouldn't
  // punish a clearly-correct match" fix: even when DataOne can't decode the
  // VIN — or when free-text engine strings on either side parse to
  // different fuels (e.g. one side has "1.5L Turbo", the other has the same
  // 1.5L misannotated as Diesel) — the same VIN means the same physical
  // vehicle, full stop. This MUST run before the fuel-mismatch gate or it
  // will incorrectly drop genuine same-vehicle history.
  const tVinNorm = normalizeVin(targetVehicle.vin);
  const jVinNorm = normalizeVin(job.vehicle?.vin ?? job.vin);
  const sameVin = tVinNorm !== null && jVinNorm !== null && tVinNorm === jVinNorm;

  // ----- Vehicle-system classification (Task #364) -----
  // Bucket the donor job into the system it actually touched (brakes,
  // suspension, hvac, powertrain, etc.) so we can pick category-appropriate
  // weights below. Unrecognized titles fall back to "general", which
  // preserves today's powertrain-equivalent behavior as a safe default.
  const rawLineItems: any[] = Array.isArray(job.job?.lineItems)
    ? job.job.lineItems
    : Array.isArray(job.lineItems)
      ? job.lineItems
      : [];
  const lineItemTexts: string[] = rawLineItems
    .map((li: any) => {
      if (typeof li === "string") return li;
      if (li && typeof li === "object") {
        return li.description || li.name || li.title || "";
      }
      return "";
    })
    .filter(Boolean);
  const vehicleSystem = classifyVehicleSystem(
    job.job?.title || job.title,
    lineItemTexts,
  );
  const profile = getCategoryProfile(vehicleSystem);

  if (sameVin) {
    const vinPositives: string[] = ["Same vehicle (VIN match)"];
    if (targetYear && jobYear && targetYear === jobYear) {
      vinPositives.push("Exact year");
    }
    const queryCat = searchQuery ? getServiceCategory(searchQuery) : null;
    const jobCat = getServiceCategory(job.job?.title || job.title);
    if (queryCat && jobCat && queryCat === jobCat) {
      vinPositives.push(`Service category match (${jobCat})`);
    }
    return {
      ...job,
      matchScore: 100,
      matchBand: "exact" as ScoreBand,
      matchBandLabel: "Exact Fit",
      matchReason: buildMatchReason(vinPositives, []),
      gatePass: true,
      lowConfidence: false,
      crossClassPenalized: false,
      sameVinFastPath: true,
      vehicleSystem,
      scoreBreakdown: {
        gvwrClass: 0,
        bodyStyle: 0,
        model: 0,
        make: 0,
        displacement: 0,
        driveType: 0,
        year: 0,
        serviceCategory: 0,
        crossClassMultiplier: 1.0,
        evidenceBonus: 0,
        vehicleSystem,
        engineSignalsApplied: profile.engineSignalsApplied,
        fuelGateApplied: profile.fuelGateApplied,
      },
    };
  }

  // ----- Fuel safety gate (hard fail diesel-vs-gas) -----
  // Runs *after* the same-VIN fast path: if it's the same physical vehicle,
  // fuel parsing disagreements (typos, partial decode, free-text engine
  // strings) shouldn't drop a clearly-correct match. For non-same-VIN
  // donors we still hard-fail any diesel-vs-gas mismatch — but only when
  // the donor job's vehicle system actually depends on the engine
  // (powertrain / unclassified). A diesel F-250 ball joint is the same
  // ball joint as a gas F-250 ball joint, so chassis / brake / HVAC /
  // wheel-tire / body / electrical jobs skip the gate (Task #364).
  const tFuel = targetSpecs?.fuelType || parseSimpleFuel(targetVehicle.engine);
  const jFuel = jobSpecs?.fuelType || parseSimpleFuel(job.vehicle?.engine);
  if (profile.fuelGateApplied && tFuel && jFuel && tFuel !== jFuel) {
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
        vehicleSystem,
      };
    }
  }

  // ----- GVWR class (vehicle weight band) -----
  const tGvwr = targetSpecs?.gvwrBand || inferGvwrBandFromModel(vehicleMake || null, vehicleModel || null);
  const jGvwr = jobSpecs?.gvwrBand || inferGvwrBandFromModel(job.vehicle?.make || null, job.vehicle?.model || null);

  let gvwrScore = 0;
  let gvwrMatch = false;
  if (tGvwr && jGvwr) {
    if (tGvwr === jGvwr) {
      gvwrScore = 20;
      gvwrMatch = true;
      positives.push(`Same vehicle class (${tGvwr})`);
    } else {
      // This is material — advisor should know.
      materialMisses.push(`Different class (${tGvwr} vs ${jGvwr})`);
    }
  }

  // ----- Body style -----
  const tBodyGroup = normalizeBodyGroup(targetSpecs?.bodyType);
  const jBodyGroup = normalizeBodyGroup(jobSpecs?.bodyType);
  let bodyScore = 0;
  if (tBodyGroup && jBodyGroup && tBodyGroup === jBodyGroup) {
    bodyScore = 12;
    positives.push("Same body style");
  }

  // ----- Model -----
  const targetModelLower = vehicleModel?.toLowerCase() || "";
  const jobModelLower = job.vehicle?.model?.toLowerCase() || "";
  let modelScore = 0;
  let sameModel = false;
  if (targetModelLower && jobModelLower) {
    if (targetModelLower === jobModelLower) {
      modelScore = 25;
      sameModel = true;
      positives.push("Same model");
    } else if (targetModelLower.includes(jobModelLower) || jobModelLower.includes(targetModelLower)) {
      modelScore = 14;
      positives.push("Model family match");
    }
  }

  // ----- Make -----
  // Task #182: stop punishing same-make matches just because DataOne couldn't
  // resolve the GVWR class. Same make = full credit unless we *know* it's a
  // class mismatch. That's the cross-class case, handled by the multiplier
  // below — we do NOT add the noisy "Same make (cross-class, no credit)"
  // reason here because the materialMisses entry already conveys the doubt.
  const targetMakeLower = vehicleMake?.toLowerCase() || "";
  const jobMakeLower = job.vehicle?.make?.toLowerCase() || "";
  const sameMake = !!targetMakeLower && targetMakeLower === jobMakeLower;
  let makeScore = 0;
  if (sameMake) {
    if (tGvwr && jGvwr && tGvwr !== jGvwr) {
      makeScore = 0;
    } else {
      makeScore = 10;
      // Don't add "Same make" to positives when we already have "Same model"
      // (it's redundant); only add it when model didn't match.
      if (!sameModel && modelScore === 0) {
        positives.push("Same make");
      }
    }
  }

  // ----- Displacement -----
  // Task #364: only contribute (positively or negatively) when this job's
  // category actually depends on the engine. For chassis / brake / HVAC /
  // body / wheel-tire / electrical work we ignore engine size entirely,
  // and we suppress the "Different engine" material miss so the advisor
  // sees "Matched as: Suspension — engine ignored" instead of being told
  // the engine was a problem when it wasn't.
  const tDisp = targetSpecs?.displacement || parseDisplacementFromEngine(targetVehicle.engine);
  const jDisp = jobSpecs?.displacement || parseDisplacementFromEngine(job.vehicle?.engine);
  let displacementScore = 0;
  let displacementClose = false;
  if (profile.engineSignalsApplied && tDisp && jDisp) {
    const diff = Math.abs(tDisp - jDisp);
    if (diff <= 0.5) {
      displacementScore = 15;
      displacementClose = true;
      positives.push(`Same engine (${jDisp}L)`);
    } else if (diff <= 1.5) {
      displacementScore = 8;
      positives.push(`Similar engine (${jDisp}L)`);
    } else if (sameModel) {
      // Same model but very different engine size — material to the advisor
      materialMisses.push(`Different engine (${jDisp}L vs ${tDisp}L)`);
    }
  }

  // ----- Drive type -----
  const tDrive = (targetSpecs?.driveType || '').toUpperCase();
  const jDrive = (jobSpecs?.driveType || '').toUpperCase();
  let driveScore = 0;
  if (tDrive && jDrive) {
    if (tDrive === jDrive) {
      driveScore = 8;
      positives.push("Same drive type");
    } else if (
      (tDrive.includes('AWD') && jDrive.includes('4WD')) ||
      (tDrive.includes('4WD') && jDrive.includes('AWD'))
    ) {
      driveScore = 5;
    }
  }

  // ----- Year -----
  let yearScore = 0;
  let yearDiff: number | null = null;
  if (targetYear && jobYear) {
    yearDiff = Math.abs(targetYear - jobYear);
    if (yearDiff === 0) {
      yearScore = 10;
      positives.push("Exact year");
    } else if (yearDiff === 1) {
      yearScore = 8;
      positives.push("1 year off");
    } else if (yearDiff === 2) {
      yearScore = 6;
      positives.push("2 years off");
    } else if (yearDiff <= 5) {
      yearScore = 3;
      positives.push(`${yearDiff} years off`);
    } else {
      // Big year gap is a material miss only when the model otherwise matches.
      if (sameModel) {
        materialMisses.push(`${yearDiff} years off`);
      }
    }
  }

  // ----- Service category (matches what the advisor was searching for) -----
  const jobTitle = job.job?.title || job.title || '';
  const jobCategory = getServiceCategory(jobTitle);
  const queryCategory = searchQuery ? getServiceCategory(searchQuery) : null;
  let categoryScore = 0;
  if (queryCategory && jobCategory) {
    if (queryCategory === jobCategory) {
      categoryScore = 15;
      positives.push(`Service category match (${jobCategory})`);
    }
  } else if (jobCategory && !queryCategory) {
    categoryScore = 5;
  }

  let rawScore =
    gvwrScore + bodyScore + modelScore + makeScore +
    displacementScore + driveScore + yearScore + categoryScore;

  // ----- Cross-class penalty (safety win we are NOT undoing) -----
  let crossClassMultiplier = 1.0;
  let crossClassPenalized = false;
  if (tGvwr && jGvwr && tGvwr !== jGvwr) {
    crossClassMultiplier = 0.2;
    crossClassPenalized = true;
    rawScore = Math.round(rawScore * crossClassMultiplier);
  }

  // ----- Supportive evidence bonuses (Task #182) -----
  // These are *small* — they nudge a confident match into Exact, not the
  // other way around. They never apply on top of the cross-class penalty.
  let evidenceBonus = 0;
  if (!crossClassPenalized) {
    // Recency: a job done in the last 12 months on this vehicle class is more
    // relevant than something from 5 years ago.
    if (job.performedAt) {
      const performedAt = new Date(job.performedAt).getTime();
      if (!Number.isNaN(performedAt)) {
        const nowMs = (options?.now ?? new Date()).getTime();
        const ageMonths = (nowMs - performedAt) / (1000 * 60 * 60 * 24 * 30);
        if (ageMonths <= 6) {
          evidenceBonus += 5;
          positives.push("Recent");
        } else if (ageMonths <= 12) {
          evidenceBonus += 3;
          positives.push("Recent");
        }
      }
    }

    // Same shop: an advisor sees their own shop's history as more trustworthy.
    if (options?.currentShopId != null && job.shopId != null) {
      if (Number(options.currentShopId) === Number(job.shopId)) {
        evidenceBonus += 5;
        positives.push("Same shop");
      }
    }

    // Corroboration: multiple matching donor jobs reinforce the suggestion.
    const corr = options?.corroboratingCount ?? 0;
    if (corr > 1) {
      const corrBonus = Math.min(6, (corr - 1) * 2);
      evidenceBonus += corrBonus;
      // Only mention corroboration when it's substantive (3+ matches).
      if (corr >= 3) {
        positives.push(`${corr} matching jobs`);
      }
    }
  }

  rawScore += evidenceBonus;

  let finalScore = Math.max(0, Math.min(100, rawScore));

  // ----- Same-make + same-model + close-year guarantee (Task #182) -----
  // "Same-make + same-model + same-engine within ±1 year should also be
  // guaranteed at least Great Match even if GVWR / body / displacement
  // didn't decode." If both engines decoded and disagree, the materialMisses
  // path above will already have mentioned it; the floor still applies as
  // long as the displacement is *not* a material mismatch.
  const closeYear = yearDiff !== null && yearDiff <= 1;
  // For non-powertrain categories the engine is ignored, so engine
  // disagreement never blocks the same-make+model+close-year floor
  // (Task #364). For powertrain we keep the original guard.
  const engineMatchOrUnknown =
    !profile.engineSignalsApplied || !tDisp || !jDisp || displacementClose;
  if (
    sameMake &&
    sameModel &&
    closeYear &&
    engineMatchOrUnknown &&
    !crossClassPenalized
  ) {
    finalScore = Math.max(finalScore, SCORE_THRESHOLD_LIKELY + 5);
  }

  const band = getScoreBand(finalScore);

  return {
    ...job,
    matchScore: finalScore,
    matchBand: band,
    matchBandLabel: getBandLabel(band),
    matchReason: buildMatchReason(positives, materialMisses),
    gatePass: true,
    lowConfidence: band === "low_confidence",
    crossClassPenalized,
    sameVinFastPath: false,
    vehicleSystem,
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
      evidenceBonus,
      vehicleSystem,
      engineSignalsApplied: profile.engineSignalsApplied,
      fuelGateApplied: profile.fuelGateApplied,
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

/**
 * Count how many sibling donor jobs corroborate each scored job (Task #182).
 *
 * Two donor jobs corroborate each other when they share the same canned-job
 * title (case-insensitive) and the same vehicle make/model. The returned map
 * is keyed by the same id used by the API layer so the caller can pass the
 * count into `scoreJob` via `ScoreOptions.corroboratingCount`.
 */
export function buildCorroborationCounts(
  jobs: any[],
  idFor: (job: any) => string,
): Map<string, number> {
  const groups = new Map<string, number>();
  const ids = new Map<string, string>();
  for (const j of jobs) {
    const title = (j.job?.title || j.title || "").toLowerCase().trim();
    const make = (j.vehicle?.make || "").toLowerCase().trim();
    const model = (j.vehicle?.model || "").toLowerCase().trim();
    if (!title) continue;
    const key = `${title}|${make}|${model}`;
    groups.set(key, (groups.get(key) || 0) + 1);
    ids.set(idFor(j), key);
  }
  const result = new Map<string, number>();
  for (const [id, key] of ids) {
    result.set(id, groups.get(key) || 1);
  }
  return result;
}
