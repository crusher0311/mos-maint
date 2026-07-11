export const SERVICE_KEYS: Record<string, string[]> = {
  oil: [
    "oil and filter", "engine oil", "oil change", "replace engine oil",
    "oil filter", "replace oil filter", "change oil", "motor oil",
    "crankcase oil", "oil & filter", "synthetic oil", "conventional oil",
    "full synthetic", "semi synthetic", "high mileage oil", "lof",
    "lube oil filter", "lube, oil", "lube & oil", "oil service",
    "engine lube", "oil drain", "r&r oil filter", "r/r oil filter",
    "oil and lube", "oil change service", "maintenance oil", "routine oil"
  ],
  tire_rotation: [
    "rotate tires", "tire rotation", "rotate tyre", "tires rotated", "rotate wheels",
    "tire rotate", "rotation service", "wheel rotation", "rotate & balance",
    "rotate and balance", "tire service rotation", "4 tire rotation", "wheels rotated",
    // Task #807: real shop phrasing puts balance first ("Road Force Wheel
    // Balance & Rotation") — the existing rotate-first synonyms miss it.
    "balance & rotation", "balance and rotation",
    // Task #819: CARFAX standardized inspect phrase ("Tire condition and
    // pressure checked", 900+ hits in the cached corpus). Resolving it to
    // the tires key keeps it out of the unmatched tally; the history verb
    // guard (isInspectOnlyHistoryPhrase) still prevents it from anchoring
    // the rotation clock because "checked" is inspect-only.
    "tire condition"
  ],
  cabin_air: [
    "cabin air filter", "cabin filter", "pollen filter", "hvac filter",
    "interior air filter", "cabin air", "cabin microfilter", "a/c filter",
    "ac filter", "passenger air filter", "replace cabin filter",
    "r&r cabin filter", "r/r cabin filter", "cabin air element"
  ],
  engine_air: [
    "engine air filter", "air cleaner element", "air filter element",
    "remove & replace air filter", "air filter replace", "replace air filter",
    "air cleaner", "intake air filter", "air filter service",
    "r&r air filter", "r/r air filter", "engine air cleaner",
    "air intake filter", "replace engine air filter"
  ],
  coolant: [
    "engine coolant", "coolant flush", "replace coolant", "cooling system",
    "antifreeze", "radiator flush", "drain and fill coolant", "coolant service",
    "bg coolant", "cooling system service", "coolant exchange", "coolant change",
    "coolant drain", "flush coolant", "coolant system", "radiator coolant",
    "coolant replacement", "bg cooling system"
  ],
  brake_fluid: [
    "brake fluid", "dot4", "dot 4", "dot3", "dot 3", "brake flush",
    "brake fluid service", "brake fluid change", "brake fluid flush",
    "brake fluid exchange", "brake fluid replacement", "bg brake fluid",
    "hydraulic brake fluid", "bleed brakes", "brake bleed",
    // Task #807: production unmatched-name data — "BG Brake System
    // Service" (BG's brake service IS a fluid exchange) and "Brake System
    // Fluid Flush" phrasings never say "brake fluid" contiguously.
    "bg brake system", "brake system fluid", "brake system flush",
    // Task #819: CARFAX standardized wording ("Brake system bled").
    "brake system bled", "brakes bled"
  ],
  trans_auto: [
    "automatic transmission fluid", "atf fluid", "atf flush", "auto trans fluid",
    "transmission service", "transmission flush", "bg automatic transmission",
    "transmission fluid service", "atf change", "atf exchange", "atf service",
    "trans fluid", "trans flush", "transmission fluid change",
    "transmission fluid exchange", "bg transmission", "cvt fluid", "cvt service",
    "automatic trans service", "auto transmission service",
    "automatic transaxle fluid", "auto transaxle fluid",
    // Task #807: production unmatched-name data — "Transmission Drain and
    // Fill", "Replace Transmission Filter" (a filter service includes new
    // fluid), and "Transmission System Fluid Flush w/ electronic level
    // check" all miss the contiguous "transmission fluid" substring.
    // Task #819: a transmission filter change is a fluid service ("Transmission
    // filter replaced" in the CARFAX standardized vocabulary).
    "transmission drain", "transmission filter", "transmission system fluid"
  ],
  trans_manual: [
    "manual transmission fluid", "manual trans fluid", "mtf fluid",
    "manual trans service", "manual gearbox", "manual gearbox oil",
    "standard transmission fluid",
    "manual transaxle fluid"
  ],
  transfer_case: [
    "transfer case fluid", "transfer case flush", "transfer case oil",
    "transfer case service", "t-case fluid", "t-case service",
    // Task #819: CARFAX category rollup wording.
    "transfer case exchange", "transfer case replacement",
    "ptu", "ptu fluid", "ptu service", "power transfer unit",
    "power transfer unit fluid", "power transfer unit service"
  ],
  front_differential: [
    "front differential", "front axle fluid", "front diff",
    "front differential fluid", "front differential service",
    "front axle service", "front diff fluid", "front diff service"
  ],
  rear_differential: [
    "rear differential", "rear axle fluid", "rear diff",
    "rear differential fluid", "rear differential service", "gear oil",
    "rear axle service", "rear diff fluid", "rear diff service",
    "differential fluid", "diff fluid", "differential service"
  ],
  power_steering: [
    "power steering fluid", "power steering flush", "power steering service",
    "p/s fluid", "ps fluid", "power steering exchange", "steering fluid",
    // Task #819: "Power steering system serviced" / "Power steering system
    // flushed" in the CARFAX standardized vocabulary.
    "power steering system"
  ],
  fuel_filter: [
    "fuel filter", "replace fuel filter", "r&r fuel filter", "r/r fuel filter",
    "inline fuel filter"
  ],
  spark_plugs: [
    "spark plug", "spark plugs", "ignition tune", "tune-up", "tune up",
    "spark plug replacement", "replace spark plug", "r&r spark plug",
    "r/r spark plug", "ignition plug", "ngk spark plug", "denso spark plug",
    "champion spark plug", "platinum spark plug", "iridium spark plug",
    "change spark plug", "install spark plug", "new spark plug"
  ],
  serpentine_belt: [
    "serpentine belt", "drive belt", "accessory belt", "v-belt", "fan belt",
    "replace serpentine", "r&r serpentine", "r/r serpentine", "belt replacement",
    "accessory drive belt", "poly-v belt", "multi-rib belt", "ribbed belt"
  ],
  timing_belt: [
    "timing belt", "timing chain", "cam belt", "replace timing belt",
    "timing belt service", "timing belt replacement", "t-belt",
    "r&r timing belt", "r/r timing belt", "timing belt kit"
  ],
  fuel_system: [
    "fuel system cleaning", "fuel injector cleaning", "fuel system service", "fuel induction",
    "bg fuel", "bg platinum fuel", "induction cleaning", "throttle body cleaning",
    "fuel injection service", "fuel injector service", "injector cleaning",
    "carbon cleaning", "intake cleaning", "bg fuel system", "fuel rail cleaning",
    "fuel system flush", "gdi cleaning", "direct injection cleaning",
    // Task #807: production unmatched-name data — "Fuel Injection Flush
    // Cleaning Service (BG GDI)", "BG Air Induction Service", "Throttle
    // Body Service" (existing synonym only covered "cleaning"), and "BG
    // Engine Performance Service (BG MOA/EPR/44K)".
    "fuel injection flush", "fuel injection cleaning", "air induction",
    "throttle body service", "bg engine performance",
    // Task #819: CARFAX standardized vocabulary — "Fuel system
    // cleaned/serviced", "Fuel injection system flushed/serviced",
    // "Induction system serviced", "Throttle body cleaned/serviced".
    "fuel system cleaned", "fuel system serviced", "fuel injection system",
    "induction system", "throttle body cleaned"
  ],
  front_brake_pads: [
    "front brake pads", "front brake lining", "front brakes replaced",
    "front brake pads replaced", "front disc brake", "front brake service",
    "front brake job", "front pads", "r&r front brake pads", "r/r front pads",
    "replace front pads", "install front brake pads", "front brake pad set"
  ],
  rear_brake_pads: [
    "rear brake pads", "rear brake lining", "rear brakes replaced",
    "rear brake pads replaced", "rear disc brake", "brake shoes",
    "rear brake service", "rear brake job", "rear pads", "r&r rear brake pads",
    "r/r rear pads", "replace rear pads", "install rear brake pads",
    "rear brake pad set", "rear brake shoe"
  ],
  front_brake_rotors: [
    "front brake rotor", "front rotor", "front brake rotors replaced",
    "front rotors", "r&r front rotor", "r/r front rotor",
    "resurface front rotor", "machine front rotor", "replace front rotor"
  ],
  rear_brake_rotors: [
    "rear brake rotor", "rear rotor", "rear brake rotors replaced",
    "rear rotors", "r&r rear rotor", "r/r rear rotor",
    "resurface rear rotor", "machine rear rotor", "replace rear rotor"
  ],
  front_shocks: [
    "front shock", "front strut", "front shocks", "front struts",
    "front shock absorber", "front strut assembly", "front suspension strut",
    "r&r front strut", "r/r front strut", "replace front strut"
  ],
  rear_shocks: [
    "rear shock", "rear strut", "rear shocks", "rear struts",
    "rear shock absorber", "rear strut assembly", "rear suspension strut",
    "r&r rear strut", "r/r rear strut", "replace rear strut"
  ],
  // Control arms — a repair item, not an OEM interval, but shops decline-track
  // it and CARFAX itemizes it heavily (corpus check across 3,000 cached
  // reports: "Lower control arm(s) replaced" ×346, "Control arm(s) replaced"
  // ×178, "Upper control arm(s) replaced" ×61, bushings ×32). A key lets a
  // declined control-arm job be matched against shop/CARFAX history so the
  // flag clears when the work was done elsewhere. The bare "control arm"
  // substring also catches bushing lines — acceptable: bushing replacement is
  // control-arm service. Inspect-only phrases ("Control arm checked") are
  // blocked from anchoring by isInspectOnlyHistoryPhrase as usual.
  control_arm: [
    "control arm", "control arms"
  ],
  wheel_alignment: [
    "wheel alignment", "alignment", "all wheel alignment",
    "front alignment", "rear alignment", "4 wheel alignment",
    "four wheel alignment", "thrust alignment", "alignment check",
    "alignment service", "align wheels", "toe adjustment", "wheels aligned",
    // Task #807: "Align 4W" is the single most common unmatched alignment
    // job name in production (Tekmetric canned-job shorthand).
    "align 4w"
  ],
  battery: [
    "battery replaced", "battery replacement", "battery/charging", "replace battery",
    "new battery", "install battery", "r&r battery", "r/r battery",
    "battery service", "battery install", "car battery", "vehicle battery",
    // Task #807: "Interstate Battery" — brand-named battery install lines
    // are common in production job names. Deliberately NOT adding a bare
    // "battery" substring (would falsely catch "Key Fob Battery", battery
    // tests, terminal cleaning); the exact-equality fallback in
    // toKeyFromName / toKeyFromFreeText handles a standalone "Battery" line.
    "interstate battery"
  ],
  wiper_blades: [
    "wiper blade", "windshield wiper", "wiper replace", "wiper insert",
    "replace wiper", "wiper blades", "wiper arm", "rear wiper",
    "front wiper", "r&r wiper", "r/r wiper", "beam blade", "wiper refill",
    // Task #807: CARFAX phrases wipers as "Wiper(s) replaced" (parenthesized
    // plural), and shops sell product-line names like "Wiper - Latitude",
    // "Wiper - Bosch Clear Advantage", "WIPERLAT - Latitude", "WIPERR -
    // Rear". "wiper -" deliberately keeps the dash so "wiper motor" (a
    // repair, not a maintenance interval) stays unmatched.
    // Task #819: CARFAX standardized wording — "Wiper(s) replaced",
    // "Wiper(s) checked". The "(s)" spelling defeats the plain "wipers"
    // fallback in toKeyFromFreeText.
    "wiper(s)", "wiper -", "wiperlat", "wiperr", "wipers replaced"
  ],
  ac_refrigerant: [
    "a/c refrigerant", "ac refrigerant", "air conditioning refill",
    "a/c recharge", "ac recharge", "refrigerant", "r-134a", "r134a",
    "a/c service", "ac service", "air conditioning service",
    "a/c evacuation", "ac evacuation", "a/c charge", "ac charge",
    "r-1234yf", "r1234yf", "a/c performance", "ac performance",
    "air conditioning repair", "a/c system service",
    // Task #807: production job names phrase recharges as "Evacuation and
    // Recharge R134" / "Evacuate and Recharge R134 A/C System".
    "evacuate and recharge", "evacuation and recharge",
    // Task #819: CARFAX standardized wording — "A/C system flushed",
    // "A/C system checked" (the latter is verb-guarded so it never anchors).
    "a/c system"
  ],
  emissions: [
    "emissions test", "emissions inspection", "smog test", "smog check",
    "emission test", "emission inspection", "state inspection",
    "safety inspection", "obd test", "exhaust emission",
    // Task #819: CARFAX category rollup name for the periodic state
    // safety/emissions test. For this key the inspection IS the service
    // (INSPECTION_SERVICE_KEYS), so it legitimately anchors. Outcome-coded
    // phrases ("Passed emissions inspection" / "Failed emissions
    // inspection") both anchor the test-performed event — our key tracks
    // "test was performed", not the result.
    "safety test"
  ],
  coolant_hoses: [
    "coolant hose", "coolant hoses", "radiator hose", "heater hose",
    "upper radiator hose", "lower radiator hose", "bypass hose",
    "r&r coolant hose", "r/r coolant hose", "replace radiator hose",
    "replace heater hose"
  ],
  // Task #204: Dual-clutch transmission fluid (DSG, S-tronic, PDK,
  // PowerShift, etc.). Distinct from `trans_auto` because several OEMs
  // either spec a much longer interval (Porsche PDK ≈ 120k mi) or
  // explicitly market the unit as "sealed for life" (VW DSG 7-speed
  // dry-clutch DQ200, Ford PowerShift DPS6). Mapping these phrasings to
  // their own key keeps `trans_auto` ATF/CVT cadences clean.
  dct: [
    "dct fluid", "dct service", "dct oil",
    "dual clutch transmission fluid", "dual-clutch transmission fluid",
    "dual clutch fluid", "dual-clutch fluid",
    "dsg fluid", "dsg service", "dsg oil",
    "s-tronic fluid", "s tronic fluid", "stronic fluid",
    "pdk fluid", "pdk service", "pdk oil",
    "powershift fluid", "powershift service",
    "7g-dct fluid", "7g dct fluid"
  ],
  // Task #204: Haldex / electronically-controlled AWD coupling fluid
  // (VW/Audi quattro on transverse, Volvo AWD, Land Rover ATC, some
  // Subaru ATC, some Mazda i-Activ). Several OEMs ship these units
  // with no scheduled service in the owner's manual even though the
  // coupling supplier (BorgWarner Haldex) recommends ~30k mi.
  awd_coupling: [
    "haldex fluid", "haldex oil", "haldex service",
    "haldex filter", "awd coupling", "awd coupling fluid",
    "awd clutch fluid", "rear coupling fluid",
    "active on demand fluid", "active on-demand fluid",
    "atc fluid", "atc service", "i-activ fluid"
  ],
  // Task #204: Hybrid / EV power-electronics coolant. Separate cooling
  // loop for the inverter, traction motor, and HV battery. Honda IMA
  // hybrids and several BEV platforms list this loop as not requiring
  // scheduled replacement; Toyota's hybrid coolant is on a long-life
  // 100k+ mi interval. We treat the no-interval cases as lifetime.
  hybrid_coolant: [
    "inverter coolant", "hybrid coolant", "hybrid system coolant",
    "battery coolant", "hv battery coolant", "high voltage coolant",
    "high-voltage coolant", "ev coolant", "power electronics coolant",
    "traction battery coolant", "drive motor coolant"
  ],
};

export const SERVICE_KEY_DISPLAY_NAMES: Record<string, string> = {
  oil: "Oil Change",
  tire_rotation: "Tire Rotation",
  cabin_air: "Cabin Air Filter",
  engine_air: "Engine Air Filter",
  coolant: "Coolant Service",
  brake_fluid: "Brake Fluid Service",
  trans_auto: "Automatic Transmission Fluid",
  trans_manual: "Manual Transmission Fluid",
  transfer_case: "Transfer Case Fluid",
  front_differential: "Front Differential Fluid",
  rear_differential: "Rear Differential Fluid",
  power_steering: "Power Steering Fluid",
  fuel_filter: "Fuel Filter",
  spark_plugs: "Spark Plugs",
  serpentine_belt: "Serpentine Belt",
  timing_belt: "Timing Belt",
  fuel_system: "Fuel System Cleaning",
  front_brake_pads: "Front Brake Pads",
  rear_brake_pads: "Rear Brake Pads",
  front_brake_rotors: "Front Brake Rotors",
  rear_brake_rotors: "Rear Brake Rotors",
  front_shocks: "Front Shocks / Struts",
  rear_shocks: "Rear Shocks / Struts",
  control_arm: "Control Arm",
  wheel_alignment: "Wheel Alignment",
  battery: "Battery",
  wiper_blades: "Wiper Blades",
  ac_refrigerant: "A/C Service",
  emissions: "Emissions Inspection",
  coolant_hoses: "Coolant Hoses",
  dct: "DCT / Dual-Clutch Fluid",
  awd_coupling: "AWD Coupling / Haldex Fluid",
  hybrid_coolant: "Hybrid / Inverter Coolant",
};

/**
 * Default mileage used when an OE schedule lists a fluid as "lifetime",
 * "fill for life", or has no scheduled-replacement interval. Centralized so
 * shops/operators can tune it in one place. Roughly aligned with most fleet
 * recommendations of servicing sealed transmissions / coolants by ~120k mi.
 */
export const LIFETIME_FLUID_DEFAULT_MILES = 120000;

/**
 * Service keys we are willing to surface as "Recommended at 120k mi" when
 * the OE source treats the fluid as lifetime. Limited to fluids — we do not
 * fabricate intervals for parts the OE never schedules (e.g. timing belts).
 *
 * Task #204: extended beyond the original ATF / coolant / brake-fluid /
 * power-steering / differential / transfer-case / manual-trans baseline to
 * cover three more fluids that real-world OEM schedules treat as lifetime
 * on at least one platform:
 *   - `dct` — Dual-clutch transmission fluid. VW/Audi originally marketed
 *     the 7-speed dry-clutch DSG (DQ200) as a sealed-for-life unit; Ford
 *     PowerShift (DPS6) shipped with no scheduled change in the owner's
 *     manual; Porsche PDK lists "inspect at 120k mi". (Sources: VW Service
 *     Reference DSG TPI 2032359, Ford Owner's Manual DPS6 maintenance
 *     section, Porsche maintenance schedule 991/992.)
 *   - `awd_coupling` — Haldex / electronically-controlled AWD coupling
 *     fluid. The Volvo XC60/XC90 with Haldex Gen 4–5 owner's manual lists
 *     no scheduled service for the rear coupling; Land Rover ATC and
 *     several Subaru/Mazda i-Activ AWD units behave the same way.
 *     (Sources: Volvo XC90 Owner's Manual MY2017+ "Maintenance" chapter,
 *     Land Rover Range Rover Sport service schedule.)
 *   - `hybrid_coolant` — Power-electronics / HV-battery / inverter coolant.
 *     Honda IMA hybrid manuals and several BEV platforms (e.g. Tesla
 *     Model 3/Y) list no scheduled coolant replacement for the HV loop.
 *     Toyota's hybrid coolant has a long-life interval but several rows
 *     come through with no interval set, which lets the lifetime default
 *     apply only when there is genuinely no OEM cadence.
 *     (Sources: Honda Insight/Civic Hybrid maintenance schedule, Tesla
 *     Model 3 owner's manual "Service" section.)
 *
 * The `isLifetimeFluidItem` heuristic still requires an explicit lifetime
 * signal (matching text, lifetime interval-units, OR the OEM omitting
 * intervals entirely). So adding a key here CANNOT manufacture a 120k-mi
 * recommendation when the OEM did publish a real interval — the regression
 * tests in `tests/plan-build-task-204.smoke.ts` lock that down per key.
 */
export const LIFETIME_FLUID_SERVICE_KEYS = new Set<string>([
  "trans_auto",
  "trans_manual",
  "transfer_case",
  "front_differential",
  "rear_differential",
  "coolant",
  "brake_fluid",
  "power_steering",
  "dct",
  "awd_coupling",
  "hybrid_coolant",
]);

const LIFETIME_TEXT_PATTERNS: RegExp[] = [
  /\blife\s*time\b/i,
  /\blifetime\b/i,
  /fill\s*for\s*life/i,
  /filled\s*for\s*life/i,
  /no\s+scheduled\s+(?:maintenance|service|replacement)/i,
  /not\s+required/i,
  /sealed\s+for\s+life/i,
];

const LIFETIME_INTERVAL_UNITS = new Set([
  "lifetime",
  "lifetime_of_vehicle",
  "life",
  "other",
]);

/** True if a free-text string (name or notes) suggests a lifetime fluid. */
export function hasLifetimeText(text: string | null | undefined): boolean {
  if (!text) return false;
  return LIFETIME_TEXT_PATTERNS.some((p) => p.test(text));
}

/** True if a single DataOne interval row is a lifetime indicator. */
export function isLifetimeIntervalRow(row: { units?: string | null; value?: number | null }): boolean {
  const units = (row.units || "").toString().trim().toLowerCase();
  if (LIFETIME_INTERVAL_UNITS.has(units)) return true;
  // "Other" units with a 0 value or empty value sometimes indicate
  // "no scheduled service".
  if (units === "" && (row.value == null || row.value === 0)) return true;
  return false;
}

/**
 * Task #198: True when an OEM row is an "Inspect …" / "Check …" verb on a
 * known fluid (one of LIFETIME_FLUID_SERVICE_KEYS). These rows must keep
 * surfacing on the plan even when the shop has hidden generic inspect
 * items, because they are usually the only signal a customer gets about
 * that fluid (the OEM never schedules a replacement). Distinct from the
 * lifetime-fluid heuristic in `isLifetimeFluidItem` — that one fabricates a
 * recommended replacement interval; this one keeps the OEM-stated inspect
 * interval and labels it accordingly.
 */
export function isInspectOnlyFluidItem(opts: {
  serviceKey: string | null;
  action?: ServiceAction | null;
}): boolean {
  const { serviceKey, action } = opts;
  if (action !== "inspect") return false;
  return !!serviceKey && LIFETIME_FLUID_SERVICE_KEYS.has(serviceKey);
}

/**
 * Decide whether an OEM maintenance item should be treated as a lifetime
 * fluid that needs a recommended-default interval. Returns true when:
 *   - any interval row carries a lifetime unit, OR
 *   - the maintenance name / notes mention lifetime/fill-for-life, OR
 *   - the only intervals present have value <= 0 / empty units AND the
 *     service key is in the LIFETIME_FLUID_SERVICE_KEYS set (i.e. it's a
 *     fluid we're confident enough to recommend a default for).
 */
export function isLifetimeFluidItem(opts: {
  serviceKey: string | null;
  name?: string | null;
  notes?: string | null;
  miles?: number | null;
  months?: number | null;
  intervals?: Array<{ units?: string | null; value?: number | null }>;
}): boolean {
  const { serviceKey, name, notes, miles, months, intervals } = opts;
  if (hasLifetimeText(name) || hasLifetimeText(notes)) {
    return !!serviceKey && LIFETIME_FLUID_SERVICE_KEYS.has(serviceKey);
  }
  if (intervals && intervals.length > 0 && intervals.some(isLifetimeIntervalRow)) {
    return !!serviceKey && LIFETIME_FLUID_SERVICE_KEYS.has(serviceKey);
  }
  // Some sources omit intervals entirely for lifetime fluids — only treat
  // that as lifetime when the canonical service is in our fluid set AND we
  // have *some* indicator (intervals array empty AND no usable miles/months).
  if (
    !!serviceKey &&
    LIFETIME_FLUID_SERVICE_KEYS.has(serviceKey) &&
    (!miles || miles <= 0) &&
    (!months || months <= 0) &&
    (!intervals || intervals.length === 0)
  ) {
    return true;
  }
  return false;
}

export type ServiceAction =
  | "inspect"
  | "replace"
  | "flush"
  | "rotate"
  | "adjust"
  | "reset"
  | "drain"
  | "lubricate"
  | "tighten"
  | "service";

/**
 * Extract the verb / action from a maintenance item name. We need this so
 * an "Inspect …" row never gets rendered with the same display label as
 * the matching "Replace …" service. Returns null when no verb is detected.
 */
export function parseServiceAction(name: string | null | undefined): ServiceAction | null {
  if (!name) return null;
  const n = name.toLowerCase().trim();
  // Order matters — check the more specific verbs first.
  if (/^\s*(?:inspect|check|examine|visual\s*check)\b/.test(n) || /\binspection\b/.test(n)) {
    return "inspect";
  }
  if (/^\s*(?:replace|change|install|renew)\b/.test(n) || /\breplacement\b/.test(n)) {
    return "replace";
  }
  if (/^\s*(?:flush|exchange|drain\s+and\s+(?:fill|refill))\b/.test(n)) return "flush";
  if (/^\s*(?:rotate|rotation)\b/.test(n)) return "rotate";
  if (/^\s*(?:adjust|adjustment|align)\b/.test(n)) return "adjust";
  if (/^\s*(?:reset|relearn)\b/.test(n)) return "reset";
  if (/^\s*(?:drain)\b/.test(n)) return "drain";
  if (/^\s*(?:lubricate|grease|oil)\b/.test(n)) return "lubricate";
  if (/^\s*(?:tighten|torque|re-?torque)\b/.test(n)) return "tighten";
  if (/\bservice\b/.test(n)) return "service";
  return null;
}

/**
 * Whether a maintenance item is an inspection (or similar non-service
 * action) based on its source name. Preferred over title sniffing because
 * the title is sometimes rewritten to a canonical service label.
 */
export function isInspectionAction(action: ServiceAction | null | undefined): boolean {
  return action === "inspect";
}

/**
 * Service keys whose scheduled item IS an inspection (not a physical
 * replacement/flush). For these, a "checked / inspected" history record is a
 * legitimate completion and MAY anchor the interval clock. For every other
 * key, an inspect-only record must NOT reset the "last done" anchor.
 */
export const INSPECTION_SERVICE_KEYS: ReadonlySet<string> = new Set(["emissions"]);

/**
 * Split a free-text service description into individual service phrases.
 * CARFAX joins multiple bullet lines into one description with "; " (see
 * lib/integrations/carfax.ts), so a single record often mixes performed
 * services ("Oil and filter changed") with inspect-only notes ("Drive belts
 * checked"). Splitting lets the verb be judged per phrase.
 */
export function splitServicePhrases(desc: string | null | undefined): string[] {
  return (desc || "")
    .split(/\s*;\s*|[\r\n]+|\s*[•\u2022]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * True when a single service phrase describes an INSPECTION ONLY — the item
 * was examined but not actually performed — so it must not anchor a
 * replacement/service interval as "last done".
 *
 * CARFAX / shop-history phrasing puts the verb AFTER the noun ("Drive belts
 * checked", "Tire condition and pressure checked", "Alignment checked"),
 * which `parseServiceAction` (anchored to leading verbs) misses. Rule: a
 * performed-service verb anywhere in the phrase (replaced, changed, flushed,
 * rotated, balanced, serviced, aligned, …) means the work WAS done → not
 * inspect-only. Otherwise a check / inspect / test verb means it was only
 * examined. Word-stem boundaries avoid noun collisions (e.g. the "align" in
 * "alignment checked" must not read as the verb "aligned").
 */
export function isInspectOnlyHistoryPhrase(phrase: string | null | undefined): boolean {
  const s = (phrase || "").toLowerCase();
  if (!s.trim()) return false;
  const PERFORMED =
    /\b(?:replac\w*|chang\w*|renew\w*|install\w*|flush\w*|exchang\w*|rotat\w*|balanc\w*|drain\w*|refill\w*|resurfac\w*|machin\w*|rebuil\w*|overhaul\w*|servic\w*|perform\w*|adjust\w*|aligned|lubricat\w*|greas\w*|clean\w*|topped)\b/;
  if (PERFORMED.test(s)) return false;
  const INSPECT = /\b(?:check\w*|inspect\w*|examin\w*|test\w*|verif\w*|monitor\w*|measur\w*)\b/;
  return INSPECT.test(s);
}

/**
 * Resolve free-text service history (a CARFAX record or a shop line item) to
 * the service keys it should ANCHOR as "last done". CARFAX joins multiple
 * bullet lines into one description with "; " (see lib/integrations/carfax.ts)
 * and phrases the verb AFTER the noun ("Drive belts checked"), so we split
 * into phrases and verb-guard each one: an inspect-only phrase never anchors a
 * replacement service — only INSPECTION_SERVICE_KEYS (e.g. emissions) may be
 * anchored by an inspect verb, since for those the inspection IS the service.
 * A record mixing "Oil and filter changed" with "Drive belts checked" anchors
 * the oil (performed) but not the belts (inspected).
 */
export function toAnchorKeysFromHistory(text: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const phrase of splitServicePhrases(text)) {
    const keys = toKeyFromFreeText(phrase);
    if (keys.length === 0) continue;
    const inspectOnly = isInspectOnlyHistoryPhrase(phrase);
    for (const k of keys) {
      if (inspectOnly && !INSPECTION_SERVICE_KEYS.has(k)) continue;
      out.add(k);
    }
  }
  return Array.from(out);
}

export function toKeyFromName(name: string): string | null {
  const n = name.toLowerCase();
  const DVI_SKIP = ["oil change sticker", "walk around video", "walk around", "other"];
  if (DVI_SKIP.some((s) => n === s)) return null;
  if (n.includes("cabin") && n.includes("air") && n.includes("filter")) return "cabin_air";
  if (n === "cabin air filter" || n === "cabin air") return "cabin_air";
  // Task #819: mirror the free-text accessory-battery guard — a key-fob /
  // remote battery item must not resolve to the vehicle-battery key.
  const accessoryBattery = n.includes("battery") && /\b(?:remote|fob|keyless)\b/.test(n);
  for (const [key, vals] of Object.entries(SERVICE_KEYS)) {
    if (key === "battery" && accessoryBattery) continue;
    if (vals.some((v) => n.includes(v))) return key;
  }
  if (n.includes("air filter") && !n.includes("cabin")) return "engine_air";
  if (n === "air filter") return "engine_air";
  if (n.includes("exhaust system")) return "exhaust";
  if (n.includes("transmission fluid") || n.includes("transmission flush")) return "trans_auto";
  // DataOne phrases the automatic-trans fluid service as "Replace automatic
  // transmission / transaxle fluid.", which the substrings above miss because
  // "transmission" and "fluid" are split by "/ transaxle". Catch any
  // transaxle-fluid service here, routing manual transaxles to trans_manual.
  if (n.includes("transaxle") && (n.includes("fluid") || n.includes("flush") || n.includes("exchange") || n.includes("service") || n.includes("drain"))) {
    return n.includes("manual") ? "trans_manual" : "trans_auto";
  }
  if (n.includes("differential") && !n.includes("front") && !n.includes("rear")) return "rear_differential";
  if (n.includes("coolant") && n.includes("hose")) return "coolant_hoses";
  if (n === "coolant/hoses") return "coolant_hoses";
  if (n.includes("shock") || n.includes("strut")) {
    if (n.includes("front")) return "front_shocks";
    if (n.includes("rear")) return "rear_shocks";
    return "front_shocks";
  }
  if (n.includes("brake rotor") || n.includes("rotor replaced") || n.includes("rotor(s) replaced")) {
    if (n.includes("front")) return "front_brake_rotors";
    if (n.includes("rear")) return "rear_brake_rotors";
    return "front_brake_rotors";
  }
  if (n.includes("brake pad") || n.includes("brake lining") || n.includes("brakes replaced") || n.includes("brakes serviced") || n.includes("brakes checked") || n.includes("brakes inspected") || n.includes("disc brake")) {
    if (n.includes("front")) return "front_brake_pads";
    if (n.includes("rear")) return "rear_brake_pads";
    return "front_brake_pads";
  }
  if (n === "front brakes" || n === "front brake") return "front_brake_pads";
  if (n === "rear brakes" || n === "rear brake") return "rear_brake_pads";
  if (n.includes("windshield wiper") || n === "windshield wipers" || n === "wipers") return "wiper_blades";
  // Task #807: exact-equality fallbacks for bare one-word job/document lines
  // seen in production unmatched-name logs ("Battery" ×345, "Coolant",
  // "Rotation", "Rotate"). Exact match on purpose — a bare-substring
  // "battery" synonym would falsely catch "Key Fob Battery" / "Check
  // Battery", and a bare "coolant" substring would catch "Coolant Leak".
  const trimmed = n.trim();
  if (trimmed === "battery") return "battery";
  if (trimmed === "coolant") return "coolant";
  if (trimmed === "rotation" || trimmed === "rotate") return "tire_rotation";
  return null;
}

/**
 * Task #434: Hand-curated "implies-reset" relationships. Some CARFAX
 * lines describe a parent service whose completion implicitly resets a
 * different child service's interval clock — e.g. "Four tires replaced"
 * resets the rotation cadence even when no explicit "tires rotated"
 * record exists. The triage layer falls back to the freshest matching
 * parent record as the child's anchor when no direct child record is
 * available.
 *
 * Conservative on purpose:
 *   - Map is hand-curated (no LLM-generated relationships).
 *   - One hop only — we do not cascade implied resets through chains.
 *   - Children must be existing canonical service keys.
 *   - Direct child records always beat the implied fallback.
 *
 * Most of these parents *also* match the canonical SERVICE_KEYS for
 * their child via `toKeyFromFreeText` (e.g. "Battery replaced" already
 * matches the `battery` key directly). They are listed here for
 * documentation / safety-net coverage even when redundant — the
 * tires-rotation pair is the one that genuinely changes behavior today.
 */
export const IMPLIES_RESET: Array<{
  /** Stable id for the parent service (used by `lastSource: "implied"`). */
  parentKey: string;
  /** Customer-facing label for the parent service ("tire replacement"). */
  parentName: string;
  /** Free-text patterns that recognize the parent on a CARFAX line. */
  parentMatchers: RegExp[];
  /** Existing canonical service keys whose interval clock is reset. */
  childKeys: string[];
}> = [
  {
    parentKey: "tires_replaced",
    parentName: "tire replacement",
    parentMatchers: [
      /\btires?\s+replaced\b/i,
      /\b(?:four|4|two|2|all)\s+tires?\s+(?:replaced|installed|mounted)\b/i,
      /\bnew\s+(?:set\s+of\s+)?tires?\b/i,
      /\btire\s+replacement\b/i,
      // Task #819: CARFAX's "(s)" spelling — "Tire(s) replaced",
      // "Tire(s) mounted" — defeats the plain \btires?\s+ patterns above.
      /\btires?\(s\)\s+(?:replaced|installed|mounted)\b/i,
    ],
    childKeys: ["tire_rotation"],
  },
  {
    parentKey: "front_brake_pads_replaced",
    parentName: "front brake pad replacement",
    parentMatchers: [
      /\bfront\s+brake\s+pads?\s+replaced\b/i,
      /\bfront\s+brakes?\s+replaced\b/i,
    ],
    childKeys: ["front_brake_pads"],
  },
  {
    parentKey: "rear_brake_pads_replaced",
    parentName: "rear brake pad replacement",
    parentMatchers: [
      /\brear\s+brake\s+pads?\s+replaced\b/i,
      /\brear\s+brakes?\s+replaced\b/i,
    ],
    childKeys: ["rear_brake_pads"],
  },
  {
    parentKey: "battery_replaced",
    parentName: "battery replacement",
    parentMatchers: [
      /\bbattery\s+(?:replaced|installed|replacement)\b/i,
      /\bnew\s+battery\b/i,
    ],
    childKeys: ["battery"],
  },
  {
    parentKey: "spark_plugs_replaced",
    parentName: "spark plug replacement",
    parentMatchers: [
      /\bspark\s+plugs?\s+replaced\b/i,
      /\bnew\s+spark\s+plugs?\b/i,
    ],
    childKeys: ["spark_plugs"],
  },
  {
    parentKey: "engine_air_filter_replaced",
    parentName: "engine air filter replacement",
    parentMatchers: [
      /\bengine\s+air\s+filter\s+replaced\b/i,
      // Task #819: negative lookbehind so "Cabin air filter replaced" does
      // not imply an engine-air-filter reset.
      /(?<!cabin\s)\bair\s+filter\s+replaced\b/i,
    ],
    childKeys: ["engine_air"],
  },
  {
    parentKey: "cabin_air_filter_replaced",
    parentName: "cabin air filter replacement",
    parentMatchers: [
      /\bcabin\s+air\s+filter\s+replaced\b/i,
      /\bcabin\s+filter\s+replaced\b/i,
    ],
    childKeys: ["cabin_air"],
  },
  {
    parentKey: "coolant_replaced",
    parentName: "coolant service",
    parentMatchers: [
      /\bcoolant\s+(?:replaced|flushed?|exchange[d]?)\b/i,
      /\bantifreeze\s+(?:replaced|flushed?)\b/i,
      /\bradiator\s+flushed?\b/i,
    ],
    childKeys: ["coolant"],
  },
  {
    parentKey: "trans_fluid_replaced",
    parentName: "transmission fluid service",
    parentMatchers: [
      /\btransmission\s+fluid\s+(?:replaced|flushed?|exchange[d]?)\b/i,
      /\b(?:atf|automatic\s+transmission\s+fluid)\s+(?:replaced|flushed?|exchange[d]?|service[d]?)\b/i,
    ],
    childKeys: ["trans_auto"],
  },
  // Task #819: replacing a major cooling-system component requires draining
  // and refilling the coolant, so it resets the coolant-exchange clock.
  // Deliberately narrow (water pump / radiator only) — thermostat and hose
  // jobs often only partially drain the system.
  {
    parentKey: "cooling_component_replaced",
    parentName: "cooling-system component replacement",
    parentMatchers: [
      /\bwater\s+pump\s+replaced\b/i,
      /\bradiator\s+replaced\b/i,
    ],
    childKeys: ["coolant"],
  },
  // Task #819: the drain-plug gasket is only ever replaced during an oil
  // change ("Drain plug gasket replaced" is a CARFAX standardized phrase
  // that frequently appears without an accompanying oil-change line).
  {
    parentKey: "oil_drain_plug_gasket_replaced",
    parentName: "oil change (drain plug gasket)",
    parentMatchers: [
      /\bdrain\s+plug\s+gasket\s+replaced\b/i,
    ],
    childKeys: ["oil"],
  },
];

/**
 * Returns the implies-reset matches for a free-text CARFAX description.
 * One CARFAX line can match multiple parents (rare but allowed); the
 * caller is responsible for deduping by `(parentKey, childKey)` if needed.
 */
export function findImpliesResetMatches(
  description: string,
): Array<{ parentKey: string; parentName: string; childKey: string }> {
  const out: Array<{ parentKey: string; parentName: string; childKey: string }> = [];
  if (!description) return out;
  for (const entry of IMPLIES_RESET) {
    if (entry.parentMatchers.some((rx) => rx.test(description))) {
      for (const child of entry.childKeys) {
        out.push({ parentKey: entry.parentKey, parentName: entry.parentName, childKey: child });
      }
    }
  }
  return out;
}

export function toKeyFromFreeText(desc: string): string[] {
  const d = desc.toLowerCase();
  const hits: string[] = [];
  for (const [key, vals] of Object.entries(SERVICE_KEYS)) {
    if (vals.some((v) => d.includes(v))) hits.push(key);
  }
  // Task #819: word-boundary match so "Ignition coil(s) replaced" (or any
  // other "…coil…" phrase) no longer false-positives the oil-change key and
  // resets the oil clock.
  if (/\boil\b/.test(d) && !hits.includes("oil")) hits.push("oil");
  if (d.includes("rotate") && d.includes("tire") && !hits.includes("tire_rotation")) hits.push("tire_rotation");
  // Mirror the toKeyFromName transaxle fallback so a shop-history row phrased
  // with "transaxle" anchors the same trans key the OEM item resolves to.
  if (
    d.includes("transaxle") &&
    (d.includes("fluid") || d.includes("flush") || d.includes("exchange") || d.includes("service") || d.includes("drain")) &&
    !hits.includes("trans_auto") &&
    !hits.includes("trans_manual")
  ) {
    hits.push(d.includes("manual") ? "trans_manual" : "trans_auto");
  }
  // Task #655: mirror the post-loop special cases in `toKeyFromName` so the
  // OEM-name matcher and this free-text (CARFAX / shop-history) matcher stay
  // in sync. Without these, common CARFAX phrasings ("Air filter",
  // "Transmission fluid replaced", "Brakes serviced", "Wipers replaced", …)
  // resolve to a key when they arrive as an OEM item name but to nothing as
  // a CARFAX record, so the service reads "not done" even though it was.
  // Each branch is additive and guarded so it never duplicates or overrides
  // a more specific list hit above.
  if (d.includes("air filter") && !d.includes("cabin") && !hits.includes("engine_air")) {
    hits.push("engine_air");
  }
  if (
    (d.includes("transmission fluid") || d.includes("transmission flush")) &&
    !hits.includes("trans_auto") &&
    !hits.includes("trans_manual")
  ) {
    hits.push(d.includes("manual") ? "trans_manual" : "trans_auto");
  }
  if (
    d.includes("differential") &&
    !d.includes("front") &&
    !d.includes("rear") &&
    !hits.includes("rear_differential") &&
    !hits.includes("front_differential")
  ) {
    hits.push("rear_differential");
  }
  if (d.includes("coolant") && d.includes("hose") && !hits.includes("coolant_hoses")) {
    hits.push("coolant_hoses");
  }
  if (d.includes("shock") || d.includes("strut")) {
    const k = d.includes("rear") ? "rear_shocks" : "front_shocks";
    if (!hits.includes("front_shocks") && !hits.includes("rear_shocks")) hits.push(k);
  }
  if (d.includes("brake rotor") || d.includes("rotor replaced") || d.includes("rotor(s) replaced")) {
    const k = d.includes("rear") ? "rear_brake_rotors" : "front_brake_rotors";
    if (!hits.includes(k)) hits.push(k);
  }
  if (
    d.includes("brake pad") ||
    d.includes("brake lining") ||
    d.includes("brakes replaced") ||
    d.includes("brakes serviced") ||
    // Task #819: CARFAX standardized inspect phrases ("Brakes checked" /
    // "Brakes inspected"). Resolving them keeps the unmatched tally clean;
    // the history verb guard still blocks them from anchoring the pad clock.
    d.includes("brakes checked") ||
    d.includes("brakes inspected") ||
    d.includes("disc brake")
  ) {
    const k = d.includes("rear") ? "rear_brake_pads" : "front_brake_pads";
    if (!hits.includes(k)) hits.push(k);
  }
  if ((d.includes("windshield wiper") || d.includes("wipers")) && !hits.includes("wiper_blades")) {
    hits.push("wiper_blades");
  }
  // Task #807: mirror the exact-equality fallbacks at the end of
  // `toKeyFromName` so a bare one-word history line resolves to the same
  // key. Exact match on purpose — see the comment there for why a bare
  // "battery"/"coolant" substring would over-match.
  if (hits.length === 0) {
    const t = d.trim();
    if (t === "battery") hits.push("battery");
    else if (t === "coolant") hits.push("coolant");
    else if (t === "rotation" || t === "rotate") hits.push("tire_rotation");
  }
  // Task #819: a cabin-filter line ("Cabin air filter replaced/cleaned")
  // also substring-matches the engine_air synonym "air filter replace".
  // Only the cabin filter was serviced — drop the engine_air hit unless the
  // phrase explicitly mentions the engine filter too.
  if (
    hits.includes("engine_air") &&
    hits.includes("cabin_air") &&
    d.includes("cabin") &&
    !d.includes("engine air")
  ) {
    hits.splice(hits.indexOf("engine_air"), 1);
  }
  // Task #819: accessory batteries (key-fob / remote / keyless-entry) must
  // not anchor the vehicle-battery clock ("Anti-theft/keyless remote
  // battery replaced" is a CARFAX standardized phrase).
  if (hits.includes("battery") && /\b(?:remote|fob|keyless)\b/.test(d)) {
    hits.splice(hits.indexOf("battery"), 1);
  }
  return Array.from(new Set(hits));
}
