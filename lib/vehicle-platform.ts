/**
 * Vehicle platform / chassis-family resolver (Task #365).
 *
 * Real shop work — brakes, suspension, steering, HVAC, body, wheel/tire —
 * involves enormous amounts of parts that are shared across sibling models
 * built on the same platform: Chevy Tahoe / Suburban / Yukon / Escalade
 * share the same chassis hardware; F-150 / Expedition share within a
 * generation; Camry / ES350; Wrangler / Gladiator; Silverado 1500 /
 * Sierra 1500; etc.
 *
 * The matcher previously treated those as different "Models" and gave only
 * a partial Model-family credit at best, which meant a perfectly relevant
 * Suburban ball-joint donor wouldn't surface strongly when the target was
 * a Tahoe of the same year — even though the part is literally the same.
 *
 * This module owns the curated lookup table (year-range × make × model →
 * platform id) and the `resolvePlatform()` resolver. We start with the
 * highest-volume domestic and Asian platforms that cover the bulk of real
 * shop traffic. Coverage growth is iterative — the resolver returns null
 * when the vehicle isn't in the table, which preserves today's behavior.
 *
 * Important: the resolver itself does NOT decide whether platform credit
 * should be applied. That decision belongs to the per-category profile in
 * `job-scoring.ts`. Powertrain donors, for example, must never benefit
 * from a Suburban-engine ↔ Tahoe-engine "platform credit" because the
 * powertrain isn't actually shared in any meaningful way.
 */

export type PlatformId = string;

export interface PlatformResolution {
  id: PlatformId;
  /** Human-readable description used in the score breakdown. */
  description: string;
}

interface PlatformRule {
  id: PlatformId;
  description: string;
  /** Lowercased makes that this rule applies to. */
  makes: string[];
  /** Case-insensitive model pattern. Anchored with `\b` for safety. */
  models: RegExp;
  yearMin: number;
  yearMax: number;
}

/**
 * Curated platform table. Each entry documents its source briefly so future
 * additions follow the same standard:
 *   - GM "K2XX" / "T1XX" platform names are publicly documented by GM and
 *     widely used by the aftermarket.
 *   - Ford P415 (T3) / P702 (T6) generation codes for F-150/Expedition.
 *   - Ford P558 / "S2" Super Duty generations.
 *   - Jeep JL / JT for Wrangler/Gladiator.
 *   - Toyota TNGA-K for Camry/ES350; AN-N300 for Tacoma 3rd gen; J150
 *     (4Runner 5th gen) overlap with Tacoma frame is treated as a
 *     "midsize truck/SUV body-on-frame" group.
 *
 * Order matters only when two rules could match the same vehicle; we keep
 * the table small and non-overlapping by scoping each rule with year ranges.
 */
const PLATFORM_RULES: PlatformRule[] = [
  // ---------------- GM HD trucks (2500/3500) ----------------
  // Listed first so that "Silverado 2500HD" doesn't get swallowed by the
  // 1500-truck regexes below (whose `silverado` stem matches before the
  // year/trim suffix is considered).
  {
    id: "GMT-T1HD",
    description: "GM T1 heavy-duty truck",
    makes: ["chevrolet", "chevy", "gmc"],
    models: /\b(silverado\s*[23][05]00\s*hd|silverado\s*[23][05]00|sierra\s*[23][05]00\s*hd|sierra\s*[23][05]00)\b/i,
    yearMin: 2020,
    yearMax: 2099,
  },
  {
    id: "GMT-K2HD",
    description: "GM K2 heavy-duty truck",
    makes: ["chevrolet", "chevy", "gmc"],
    models: /\b(silverado\s*[23][05]00\s*hd|silverado\s*[23][05]00|sierra\s*[23][05]00\s*hd|sierra\s*[23][05]00)\b/i,
    yearMin: 2015,
    yearMax: 2019,
  },

  // ---------------- GM full-size SUV/truck (K2XX, 2014–2020) ----------------
  // SUVs (Tahoe/Suburban/Yukon/Escalade) ran K2XX 2015-2020.
  {
    id: "GMT-K2XX",
    description: "GM K2XX full-size SUV",
    makes: ["chevrolet", "chevy", "gmc", "cadillac"],
    models: /\b(tahoe|suburban|yukon(?:\s*xl)?|escalade(?:\s*esv)?)\b/i,
    yearMin: 2015,
    yearMax: 2020,
  },
  // 1500-series trucks ran K2XX 2014-2018. Negative lookahead on
  // `\s*[23][05]00` prevents matching a bare "Silverado 2500HD" via the
  // optional `1500` suffix — HD trucks belong to the K2HD/T1HD rules.
  {
    id: "GMT-K2XX",
    description: "GM K2XX full-size truck",
    makes: ["chevrolet", "chevy", "gmc"],
    models: /\b(silverado(?!\s*[23][05]00)(?:\s*1500)?|sierra(?!\s*[23][05]00)(?:\s*1500)?)\b/i,
    yearMin: 2014,
    yearMax: 2018,
  },

  // ---------------- GM full-size SUV/truck (T1XX, 2019+ trucks / 2021+ SUVs) ----------------
  {
    id: "GMT-T1XX-Truck",
    description: "GM T1 full-size truck",
    makes: ["chevrolet", "chevy", "gmc"],
    // Same negative lookahead guard as the K2XX 1500 rule above so an HD
    // trim can never be picked up by the 1500 stem.
    models: /\b(silverado(?!\s*[23][05]00)(?:\s*1500)?|sierra(?!\s*[23][05]00)(?:\s*1500)?)\b/i,
    yearMin: 2019,
    yearMax: 2099,
  },
  {
    id: "GMT-T1XX-SUV",
    description: "GM T1 full-size SUV",
    makes: ["chevrolet", "chevy", "gmc", "cadillac"],
    models: /\b(tahoe|suburban|yukon(?:\s*xl)?|escalade(?:\s*esv)?)\b/i,
    yearMin: 2021,
    yearMax: 2099,
  },

  // ---------------- Ford F-150 / Expedition / Navigator ----------------
  // P415 / "T3" generation: F-150 2015-2020; Expedition / Navigator 2018-2020.
  {
    id: "Ford-T3-Fullsize",
    description: "Ford F-150 / Expedition (P415)",
    makes: ["ford", "lincoln"],
    models: /\b(f[-\s]?150|expedition(?:\s*(?:el|max))?|navigator(?:\s*l)?)\b/i,
    yearMin: 2015,
    yearMax: 2020,
  },
  // P702 / "T6" generation: F-150 2021+; Expedition / Navigator 2021+.
  {
    id: "Ford-T6-Fullsize",
    description: "Ford F-150 / Expedition (P702)",
    makes: ["ford", "lincoln"],
    models: /\b(f[-\s]?150|expedition(?:\s*(?:el|max))?|navigator(?:\s*l)?)\b/i,
    yearMin: 2021,
    yearMax: 2099,
  },

  // ---------------- Ford Super Duty ----------------
  // P558 generation: 2017-2022 F-250/350/450/550.
  {
    id: "Ford-SuperDuty-P558",
    description: "Ford Super Duty (P558)",
    makes: ["ford"],
    models: /\b(f[-\s]?[2345]50|super\s*duty)\b/i,
    yearMin: 2017,
    yearMax: 2022,
  },
  // 2023+ refresh.
  {
    id: "Ford-SuperDuty-2023",
    description: "Ford Super Duty (2023+)",
    makes: ["ford"],
    models: /\b(f[-\s]?[2345]50|super\s*duty)\b/i,
    yearMin: 2023,
    yearMax: 2099,
  },

  // ---------------- Jeep Wrangler / Gladiator (JL / JT) ----------------
  {
    id: "Jeep-JL-JT",
    description: "Jeep Wrangler JL / Gladiator JT",
    makes: ["jeep"],
    models: /\b(wrangler|gladiator)\b/i,
    yearMin: 2018,
    yearMax: 2099,
  },

  // ---------------- Jeep Grand Cherokee / Dodge Durango (WK2 / WD) ----------------
  // GC WK2 + Durango WD share the Mercedes-derived platform (2011-2021 GC,
  // 2011+ Durango).
  {
    id: "Mopar-WK2-WD",
    description: "Jeep Grand Cherokee WK2 / Dodge Durango",
    makes: ["jeep", "dodge"],
    models: /\b(grand\s*cherokee|durango)\b/i,
    yearMin: 2011,
    yearMax: 2021,
  },

  // ---------------- Toyota Tacoma / 4Runner (midsize body-on-frame) ----------------
  // Tacoma 3rd gen (2016+) and 4Runner 5th gen (2010+) share enormous
  // amounts of frame, suspension, brake, and steering hardware.
  {
    id: "Toyota-Midsize-BOF",
    description: "Toyota Tacoma / 4Runner midsize truck/SUV",
    makes: ["toyota"],
    models: /\b(tacoma|4[-\s]?runner)\b/i,
    yearMin: 2016,
    yearMax: 2023,
  },

  // ---------------- Toyota Tundra / Sequoia ----------------
  // 2nd-gen Tundra (2007-2021) and Sequoia (2008-2022) share the J70-style
  // full-size platform.
  {
    id: "Toyota-Fullsize-Gen2",
    description: "Toyota Tundra / Sequoia (2nd gen)",
    makes: ["toyota"],
    models: /\b(tundra|sequoia)\b/i,
    yearMin: 2007,
    yearMax: 2021,
  },
  // TNGA-F (2022+ Tundra, 2023+ Sequoia).
  {
    id: "Toyota-TNGA-F-Fullsize",
    description: "Toyota Tundra / Sequoia (TNGA-F)",
    makes: ["toyota"],
    models: /\b(tundra|sequoia)\b/i,
    yearMin: 2022,
    yearMax: 2099,
  },

  // ---------------- Toyota Camry / Lexus ES (TNGA-K) ----------------
  {
    id: "Toyota-TNGA-K-Sedan",
    description: "Toyota Camry / Lexus ES (TNGA-K)",
    makes: ["toyota", "lexus"],
    models: /\b(camry|es\s*350|es350|es\s*300h?)\b/i,
    yearMin: 2018,
    yearMax: 2099,
  },

  // ---------------- Toyota RAV4 / Lexus NX (TNGA-K crossover) ----------------
  {
    id: "Toyota-TNGA-K-CUV",
    description: "Toyota RAV4 / Lexus NX (TNGA-K)",
    makes: ["toyota", "lexus"],
    models: /\b(rav[-\s]?4|nx\s*[23]00h?|nx\s*250|nx\s*350h?)\b/i,
    yearMin: 2019,
    yearMax: 2099,
  },

  // ---------------- Toyota Highlander / Lexus RX (TNGA-K large CUV) ----------------
  {
    id: "Toyota-TNGA-K-LargeCUV",
    description: "Toyota Highlander / Lexus RX (TNGA-K)",
    makes: ["toyota", "lexus"],
    models: /\b(highlander|grand\s*highlander|rx\s*[345][05]0h?|rx\s*450h)\b/i,
    yearMin: 2020,
    yearMax: 2099,
  },

  // ---------------- Honda Pilot / Passport / Ridgeline ----------------
  // Share Honda's "Global Light Truck" unibody platform.
  {
    id: "Honda-GLT",
    description: "Honda Pilot / Passport / Ridgeline",
    makes: ["honda"],
    models: /\b(pilot|passport|ridgeline)\b/i,
    yearMin: 2016,
    yearMax: 2099,
  },

  // ---------------- Honda CR-V / Civic compact platform ----------------
  // Civic 10th gen (2016-2021) and CR-V 5th gen (2017-2022) share the
  // Honda Compact Global Platform.
  {
    id: "Honda-CGP-2016",
    description: "Honda Civic / CR-V (Compact Global Platform)",
    makes: ["honda"],
    models: /\b(civic|cr[-\s]?v)\b/i,
    yearMin: 2016,
    yearMax: 2022,
  },
];

function normalizeMake(make: string | null | undefined): string | null {
  if (!make) return null;
  return String(make).trim().toLowerCase();
}

function normalizeModel(model: string | null | undefined): string | null {
  if (!model) return null;
  return String(model).trim();
}

function parseYear(year: string | number | null | undefined): number | null {
  if (year == null) return null;
  const n = typeof year === "number" ? year : parseInt(String(year), 10);
  return Number.isFinite(n) && n > 1900 && n < 2100 ? n : null;
}

/**
 * Resolve a platform id from year/make/model. Returns null when the
 * vehicle is unknown or insufficiently specified — that preserves the
 * pre-Task-#365 behavior as the safe fallback.
 */
export function resolvePlatform(
  year: string | number | null | undefined,
  make: string | null | undefined,
  model: string | null | undefined,
): PlatformResolution | null {
  const y = parseYear(year);
  const mk = normalizeMake(make);
  const md = normalizeModel(model);
  if (y == null || !mk || !md) return null;

  for (const rule of PLATFORM_RULES) {
    if (y < rule.yearMin || y > rule.yearMax) continue;
    if (!rule.makes.includes(mk)) continue;
    if (!rule.models.test(md)) continue;
    return { id: rule.id, description: rule.description };
  }
  return null;
}

/**
 * Vehicle systems that legitimately benefit from sibling-model platform
 * credit. Powertrain, electrical, and "general" do NOT — engines,
 * transmissions, ECMs, etc. vary by model even on the same platform, and
 * crediting them would over-match.
 *
 * Kept here (rather than in `job-scoring.ts`) so the platform module owns
 * the policy of "what counts as chassis-shareable", and the scorer simply
 * asks. Imported as a typed `Set<string>` for cheap lookup.
 */
export const PLATFORM_SHAREABLE_SYSTEMS: ReadonlySet<string> = new Set([
  "suspension",
  "brakes",
  "steering",
  "hvac",
  "body",
  "wheel_tire",
]);

export function isPlatformShareableSystem(system: string | null | undefined): boolean {
  if (!system) return false;
  return PLATFORM_SHAREABLE_SYSTEMS.has(system);
}
