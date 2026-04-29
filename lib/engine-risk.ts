/**
 * Task #166: Engine-aware oil interval classifier.
 *
 * Identifies engines that historically suffer accelerated oil-related
 * wear (e.g. Pentastar 3.6L, modern turbo GDIs, 0W-20 small displacement
 * engines), so the plan builder can:
 *   1. Default the oil row to the OEM "Severe" duty interval (or, when
 *      severity is the default, surface a soft warning when the OEM
 *      interval is still long enough to be risky), and
 *   2. Auto-insert a 3,000 mi "Safety Check — oil level" recommendation.
 *
 * The classifier composes two signals:
 *   - A curated baseline of engine-family rules shipped in code.
 *   - An admin-editable Mongo collection (`engine_risk_overrides`) so
 *     operators can flag (or clear) additional engines without a deploy.
 *
 * Override docs override the baseline result. A `clear` override always
 * unflags the engine; a `flag` override always flags it.
 */

import { ObjectId, type Db } from "mongodb";

/**
 * Mileage threshold above which a flagged-engine oil interval is
 * considered "risky" and gets the soft warning chip + tooltip in the UI.
 * Centralised so shops/operators can tune later.
 */
export const OIL_INTERVAL_RISK_THRESHOLD_MILES = 7500;

/**
 * Anchor mileage for the auto-inserted "Safety Check — oil level"
 * recommendation when the engine is flagged.
 */
export const SAFETY_CHECK_OIL_LEVEL_INTERVAL_MILES = 3000;

/** Canonical service key + display title for the safety-check item. */
export const SAFETY_CHECK_OIL_LEVEL_KEY = "safety_check_oil_level";
export const SAFETY_CHECK_OIL_LEVEL_TITLE = "Safety Check — oil level";

export const ENGINE_RISK_OVERRIDES_COLLECTION = "engine_risk_overrides";

/** Subset of DataOne `vin_reference` fields the classifier inspects. */
export interface EngineProfile {
  year?: number | null;
  make?: string | null;
  model?: string | null;
  engine_name?: string | null;
  engine_size?: number | null;
  engine_block?: string | null;
  engine_cylinders?: number | null;
  engine_induction?: string | null;
  engine_aspiration?: string | null;
  fuel_type?: string | null;
}

export type EngineRiskAction = "flag" | "clear";

/**
 * Admin-editable override row. All match fields are optional and are
 * combined with AND semantics; a row with only `make` matches every
 * vehicle of that make. String fields are compared case-insensitively
 * with `includes()` so partial matches (e.g. "Pentastar") work.
 */
export interface EngineRiskOverride {
  _id?: any;
  /** Display label shown in the admin UI. */
  label: string;
  /** "flag" forces risky; "clear" forces safe. */
  action: EngineRiskAction;
  /** Human-readable rationale stored with the match. */
  reason: string;
  match: {
    make?: string | null;
    model?: string | null;
    yearMin?: number | null;
    yearMax?: number | null;
    engineNamePattern?: string | null;
    engineSize?: number | null;
    induction?: string | null;
    aspiration?: string | null;
    cylindersMax?: number | null;
  };
  createdAt?: Date;
  updatedAt?: Date;
  createdBy?: string | null;
}

export type EngineRiskSource =
  | "baseline"
  | "override-flag"
  | "override-clear"
  | "none";

export interface EngineRiskResult {
  flagged: boolean;
  reasons: string[];
  source: EngineRiskSource;
  matchedOverrideId?: string | null;
  matchedOverrideLabel?: string | null;
}

interface BaselineRule {
  id: string;
  /** Short human-readable rationale shown to shops. */
  reason: string;
  matches(profile: EngineProfile): boolean;
}

function lower(value: string | null | undefined): string {
  return (value ?? "").toString().trim().toLowerCase();
}

function containsAny(haystack: string, needles: string[]): boolean {
  return needles.some((n) => n && haystack.includes(n));
}

/**
 * Curated baseline rules. Kept intentionally narrow — the override
 * collection is the escape hatch for one-off tweaks. Matching on the
 * decoded engine fields rather than year/make/model alone keeps these
 * rules robust across trim variations.
 */
const BASELINE_RULES: BaselineRule[] = [
  {
    id: "pentastar-3-6",
    reason:
      "Chrysler 3.6L Pentastar engines have documented oil-consumption " +
      "issues; 3,000 mi level checks recommended.",
    matches: (p) => {
      const make = lower(p.make);
      const isStellantis =
        make === "ram" ||
        make === "dodge" ||
        make === "jeep" ||
        make === "chrysler";
      if (!isStellantis) return false;
      const sizeMatches = typeof p.engine_size === "number" && Math.abs(p.engine_size - 3.6) < 0.05;
      const nameHints = lower(p.engine_name);
      if (sizeMatches) return true;
      if (containsAny(nameHints, ["pentastar", "3.6l v6", "3.6 l v6"])) return true;
      return false;
    },
  },
  {
    id: "turbo-gdi",
    reason:
      "Turbocharged GDI engines are prone to fuel dilution and accelerated " +
      "oil wear under modern OEM intervals.",
    matches: (p) => {
      const induction = lower(p.engine_induction);
      const aspiration = lower(p.engine_aspiration);
      const name = lower(p.engine_name);
      const isGdi =
        induction.includes("direct") ||
        induction === "gdi" ||
        name.includes("gdi") ||
        name.includes("direct injection");
      const isTurbo =
        aspiration.includes("turbo") ||
        induction.includes("turbo") ||
        name.includes("turbo");
      return isGdi && isTurbo;
    },
  },
  {
    id: "small-displacement-0w20",
    reason:
      "Small-displacement engines specifying 0W-20 oil tend to consume " +
      "oil between OEM service intervals; level checks recommended.",
    matches: (p) => {
      const name = lower(p.engine_name);
      const sizeOk = typeof p.engine_size === "number" && p.engine_size > 0 && p.engine_size <= 2.5;
      const cylOk =
        typeof p.engine_cylinders === "number" && p.engine_cylinders > 0 && p.engine_cylinders <= 4;
      const oilHint = name.includes("0w-20") || name.includes("0w20");
      // Many DataOne engine_name strings don't mention the oil grade. Fall
      // back to the well-known small-displacement Honda/Toyota/Hyundai
      // families that ship with 0W-20 from the factory.
      const make = lower(p.make);
      const familyHint =
        (make === "honda" || make === "toyota" || make === "hyundai" || make === "kia") &&
        sizeOk &&
        cylOk;
      return oilHint || familyHint;
    },
  },
];

function matchesOverride(profile: EngineProfile, override: EngineRiskOverride): boolean {
  const m = override.match || {};
  if (m.make && lower(profile.make) !== lower(m.make)) return false;
  if (m.model && !lower(profile.model).includes(lower(m.model))) return false;
  if (typeof m.yearMin === "number" && (profile.year ?? -Infinity) < m.yearMin) return false;
  if (typeof m.yearMax === "number" && (profile.year ?? Infinity) > m.yearMax) return false;
  if (m.engineNamePattern && !lower(profile.engine_name).includes(lower(m.engineNamePattern))) {
    return false;
  }
  if (typeof m.engineSize === "number" && profile.engine_size != null) {
    if (Math.abs(profile.engine_size - m.engineSize) > 0.05) return false;
  } else if (typeof m.engineSize === "number") {
    return false;
  }
  if (m.induction && !lower(profile.engine_induction).includes(lower(m.induction))) return false;
  if (m.aspiration && !lower(profile.engine_aspiration).includes(lower(m.aspiration))) return false;
  if (typeof m.cylindersMax === "number" && (profile.engine_cylinders ?? Infinity) > m.cylindersMax) {
    return false;
  }
  return true;
}

/**
 * Pure function: classify an engine using only the baseline rules. Used
 * by the plan builder when the override collection is unavailable, and
 * by the unit tests so we don't need a Mongo connection to assert
 * behaviour.
 */
export function classifyEngineRiskBaseline(profile: EngineProfile): EngineRiskResult {
  const reasons: string[] = [];
  for (const rule of BASELINE_RULES) {
    try {
      if (rule.matches(profile)) reasons.push(rule.reason);
    } catch (err) {
      console.warn(`[engine-risk] baseline rule ${rule.id} threw:`, err);
    }
  }
  if (reasons.length === 0) {
    return { flagged: false, reasons: [], source: "none" };
  }
  return { flagged: true, reasons, source: "baseline" };
}

/**
 * Combine baseline + admin overrides. Override `clear` always wins; an
 * override `flag` is preferred over a baseline-only flag so the admin
 * label/reason surface in the UI.
 */
export function classifyEngineRisk(
  profile: EngineProfile,
  overrides: EngineRiskOverride[] = [],
): EngineRiskResult {
  const baseline = classifyEngineRiskBaseline(profile);
  const matched = overrides.filter((o) => matchesOverride(profile, o));
  const clearMatch = matched.find((o) => o.action === "clear");
  if (clearMatch) {
    return {
      flagged: false,
      reasons: [clearMatch.reason || `${clearMatch.label}: cleared by admin`],
      source: "override-clear",
      matchedOverrideId: clearMatch._id ? String(clearMatch._id) : null,
      matchedOverrideLabel: clearMatch.label,
    };
  }
  const flagMatch = matched.find((o) => o.action === "flag");
  if (flagMatch) {
    return {
      flagged: true,
      reasons: [
        flagMatch.reason || `${flagMatch.label}: flagged by admin`,
        ...baseline.reasons,
      ],
      source: "override-flag",
      matchedOverrideId: flagMatch._id ? String(flagMatch._id) : null,
      matchedOverrideLabel: flagMatch.label,
    };
  }
  return baseline;
}

/**
 * Shape accepted by the write helpers below: anything `EngineRiskOverride`
 * carries except its persisted timestamps and audit fields, which the
 * helpers stamp themselves.
 */
export interface EngineRiskOverrideWriteInput {
  label: string;
  reason: string;
  action: EngineRiskAction;
  match: EngineRiskOverride["match"];
}

/**
 * Centralised insert: every code path that creates an override goes
 * through here so the audit attribution (`createdBy`, `createdAt`,
 * `updatedAt`) and the canonical Mongo collection name stay in one
 * place. Used by both the single-row POST handler and the CSV import.
 */
export async function insertEngineRiskOverride(
  db: Db,
  input: EngineRiskOverrideWriteInput,
  adminEmail: string | null,
): Promise<{ _id: string }> {
  const now = new Date();
  const result = await db.collection(ENGINE_RISK_OVERRIDES_COLLECTION).insertOne({
    label: input.label,
    reason: input.reason,
    action: input.action,
    match: input.match,
    createdAt: now,
    updatedAt: now,
    createdBy: adminEmail,
  } as EngineRiskOverride);
  return { _id: String(result.insertedId) };
}

/**
 * Centralised update: stamps `updatedAt` and `updatedBy` so audit
 * attribution does not drift across call sites.
 */
export async function updateEngineRiskOverride(
  db: Db,
  id: string | ObjectId,
  input: EngineRiskOverrideWriteInput,
  adminEmail: string | null,
): Promise<void> {
  const _id = typeof id === "string" ? new ObjectId(id) : id;
  const now = new Date();
  await db.collection(ENGINE_RISK_OVERRIDES_COLLECTION).updateOne(
    { _id },
    {
      $set: {
        label: input.label,
        reason: input.reason,
        action: input.action,
        match: input.match,
        updatedAt: now,
        updatedBy: adminEmail,
      },
    },
  );
}

/** Centralised delete so the collection name stays in one place. */
export async function deleteEngineRiskOverride(
  db: Db,
  id: string | ObjectId,
): Promise<void> {
  const _id = typeof id === "string" ? new ObjectId(id) : id;
  await db.collection(ENGINE_RISK_OVERRIDES_COLLECTION).deleteOne({ _id });
}

export async function loadEngineRiskOverrides(db: Db): Promise<EngineRiskOverride[]> {
  try {
    const docs = await db
      .collection<EngineRiskOverride>(ENGINE_RISK_OVERRIDES_COLLECTION)
      .find({})
      .toArray();
    return docs;
  } catch (err) {
    console.warn("[engine-risk] failed to load overrides:", err);
    return [];
  }
}
