/**
 * Smoke test for the Settings → Intervals "Import from document" inference
 * (lib/interval-import.ts). Fixture mirrors the real shop maintenance guide
 * the feature was built against: milestones at 15k/30k/50k/60k/90k/100k/120k.
 *
 * Run: npm run test:interval-import
 */

import {
  buildIntervalProposals,
  parseInlineRule,
  inferRecurrenceMiles,
  mapImportServiceNameToKey,
  sanitizeExtraction,
  type DocExtraction,
} from "../lib/interval-import";

let failures = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
console.log("parseInlineRule");
{
  const r1 = parseInlineRule("Brake Fluid Service (Every 2 years or 30k)");
  check("Every 2 years or 30k → 24 months", r1.months === 24, `got ${r1.months}`);
  check("Every 2 years or 30k → 30000 miles", r1.miles === 30000, `got ${r1.miles}`);

  const r2 = parseInlineRule("Cooling System Fluid Service (Every 5 years)");
  check("Every 5 years → 60 months", r2.months === 60, `got ${r2.months}`);
  check("Every 5 years → no miles", r2.miles === null, `got ${r2.miles}`);

  const r3 = parseInlineRule("every 30,000 miles");
  check("every 30,000 miles → 30000", r3.miles === 30000, `got ${r3.miles}`);

  const r4 = parseInlineRule("100k Service");
  check("bare '100k Service' (no 'every') is NOT a rule", r4.miles === null && r4.months === null);

  const r5 = parseInlineRule(null);
  check("null input → no rule", r5.miles === null && r5.months === null);
}

// ---------------------------------------------------------------------------
console.log("mapImportServiceNameToKey (gear-oil pre-pass)");
{
  check(
    "Rear Differential Gear Oil Service → rear_differential (not oil)",
    mapImportServiceNameToKey("Rear Differential Gear Oil Service") === "rear_differential",
  );
  check(
    "Front Differential Gear Oil Service → front_differential",
    mapImportServiceNameToKey("Front Differential Gear Oil Service") === "front_differential",
  );
  check(
    "Transfer Case Gear Oil Service → transfer_case",
    mapImportServiceNameToKey("Transfer Case Gear Oil Service") === "transfer_case",
  );
  check("Oil Change still → oil", mapImportServiceNameToKey("Oil Change") === "oil");
  check("Key Fob Battery → unmatched", mapImportServiceNameToKey("Key Fob Battery") === null);
}

// ---------------------------------------------------------------------------
// Task #807: synonym expansion grounded in production unmatched-name logs.
console.log("mapImportServiceNameToKey (Task #807 synonym expansion)");
{
  check(
    "BG Brake System Service → brake_fluid",
    mapImportServiceNameToKey("BG Brake System Service") === "brake_fluid",
  );
  check(
    "Brake System Fluid Flush → brake_fluid",
    mapImportServiceNameToKey("Brake System Fluid Flush") === "brake_fluid",
  );
  check("Align 4W → wheel_alignment", mapImportServiceNameToKey("Align 4W") === "wheel_alignment");
  check(
    "4-Wheel Alignment → wheel_alignment",
    mapImportServiceNameToKey("4-Wheel Alignment") === "wheel_alignment",
  );
  check(
    "Throttle Body Service → fuel_system",
    mapImportServiceNameToKey("Throttle Body Service") === "fuel_system",
  );
  check(
    "Fuel Injection Flush Cleaning Service → fuel_system",
    mapImportServiceNameToKey("Fuel Injection Flush Cleaning Service") === "fuel_system",
  );
  check(
    "BG Air Induction Service → fuel_system",
    mapImportServiceNameToKey("BG Air Induction Service") === "fuel_system",
  );
  check(
    "Transmission Drain and Fill → trans_auto",
    mapImportServiceNameToKey("Transmission Drain and Fill") === "trans_auto",
  );
  check(
    "Manual Trans Service still → trans_manual",
    mapImportServiceNameToKey("Manual Trans Service") === "trans_manual",
  );
  check("bare Battery → battery (exact match)", mapImportServiceNameToKey("Battery") === "battery");
  check(
    "Interstate Battery → battery",
    mapImportServiceNameToKey("Interstate Battery") === "battery",
  );
  check("Check Battery still → unmatched", mapImportServiceNameToKey("Check Battery") === null);
  check(
    "Clean Battery Terminals Service still → unmatched",
    mapImportServiceNameToKey("Clean Battery Terminals Service") === null,
  );
  check("bare Coolant → coolant (exact match)", mapImportServiceNameToKey("Coolant") === "coolant");
  check("Coolant Leak still → unmatched", mapImportServiceNameToKey("Coolant Leak") === null);
  check(
    "Road Force Wheel Balance & Rotation → tire_rotation",
    mapImportServiceNameToKey("Road Force Wheel Balance & Rotation") === "tire_rotation",
  );
  check(
    "Wiper - Latitude → wiper_blades",
    mapImportServiceNameToKey("Wiper - Latitude") === "wiper_blades",
  );
  check("Wiper Motor still → unmatched", mapImportServiceNameToKey("Wiper Motor") === null);
  check(
    "Evacuate and Recharge R134 A/C System → ac_refrigerant",
    mapImportServiceNameToKey("Evacuate and Recharge R134 A/C System") === "ac_refrigerant",
  );
}

// ---------------------------------------------------------------------------
console.log("inferRecurrenceMiles");
{
  const all = [15000, 30000, 50000, 60000, 90000, 100000, 120000];

  const even = inferRecurrenceMiles([30000, 60000, 90000, 120000], all);
  check("even 30k gaps → 30000 high", even.miles === 30000 && even.confidence === "high" && !even.oneTime);

  const two = inferRecurrenceMiles([50000, 100000], all);
  check("two appearances 50k apart → 50000 medium", two.miles === 50000 && two.confidence === "medium");

  const once = inferRecurrenceMiles([100000], all);
  check("single appearance → one-time low", once.oneTime && once.confidence === "low" && once.miles === 100000);

  const everyVisit = inferRecurrenceMiles(all, all);
  check(
    "appears at every milestone → smallest milestone (15000)",
    everyVisit.miles === 15000 && !everyVisit.oneTime,
    `got ${everyVisit.miles}`,
  );
}

// ---------------------------------------------------------------------------
console.log("sanitizeExtraction");
{
  check("null → null", sanitizeExtraction(null) === null);
  check("garbage → null", sanitizeExtraction({ milestones: "nope" }) === null);
  const s = sanitizeExtraction({
    milestones: [
      { miles: "30000", services: [{ name: "Tire Rotation" }] },
      { miles: -5, services: [{ name: "Bad" }] },
      { miles: 15000, services: [] },
    ],
  });
  check("coerces numbers, drops invalid milestones", s !== null && s!.milestones.length === 1 && s!.milestones[0].miles === 30000);
}

// ---------------------------------------------------------------------------
console.log("buildIntervalProposals — full guide fixture");
{
  const guide: DocExtraction = {
    milestones: [
      {
        miles: 15000,
        services: [
          { name: "Tire Rotation" },
          { name: "Inspect Cabin Air Filter" },
          { name: "Inspect Engine Air Filter" },
          { name: "Inspect Wiper Blades" },
          { name: "Review Manufacturers Recommendations" },
        ],
      },
      {
        miles: 30000,
        services: [
          { name: "Engine Air Filter Replacement" },
          { name: "Cabin Air Filter Replacement" },
          { name: "Fuel Induction Service" },
          { name: "Brake Fluid Service", note: "Every 2 years or 30k" },
          { name: "Transmission Fluid Service", note: "If applicable" },
          { name: "Tire Rotation & Balance" },
          { name: "Inspect Wiper Blades" },
          { name: "Key Fob Battery" },
          { name: "Review Manufacturers Recommendations" },
        ],
      },
      {
        miles: 50000,
        services: [
          { name: "Power Steering Fluid Service", note: "Non electric" },
          { name: "Rear Differential Gear Oil Service", note: "If applicable" },
          { name: "Front Differential Gear Oil Service", note: "If applicable" },
          { name: "Transfer Case Gear Oil Service", note: "If applicable" },
          { name: "Inspect Drive Belt(s)" },
          { name: "Tire Rotation" },
          { name: "Inspect Wiper Blades" },
          { name: "Review Manufacturers Recommendations" },
        ],
      },
      {
        miles: 60000,
        services: [
          { name: "Engine Air Filter Replacement" },
          { name: "Cabin Air Filter Replacement" },
          { name: "Fuel Induction Service" },
          { name: "Brake Fluid Service", note: "Every 2 years or 30k" },
          { name: "Spark Plugs", note: "If applicable" },
          { name: "Transmission Fluid Service", note: "If applicable" },
          { name: "Cooling System Fluid Service", note: "Every 5 years" },
          { name: "Tire Rotation & Balance" },
          { name: "Inspect Wiper Blades" },
          { name: "Key Fob Battery" },
        ],
      },
      {
        miles: 90000,
        services: [
          { name: "Engine Air Filter Replacement" },
          { name: "Cabin Air Filter Replacement" },
          { name: "Fuel Induction Service" },
          { name: "Brake Fluid Service", note: "Every 2 years or 30k" },
          { name: "Transmission Fluid Service", note: "If applicable" },
          { name: "Tire Rotation & Balance" },
          { name: "Inspect Wiper Blades" },
        ],
      },
      {
        miles: 100000,
        services: [
          { name: "Cooling System Service" },
          { name: "Spark Plugs" },
          { name: "Inspect Drive Belt(s) for Replacement" },
          { name: "Timing Belt", note: "If applicable" },
          { name: "Inspect Radiator & Heater Hoses for Replacement" },
          { name: "Power Steering Fluid Service", note: "Non electric" },
          { name: "Rear Differential Gear Oil Service", note: "If applicable" },
          { name: "Front Differential Gear Oil Service", note: "If applicable" },
          { name: "Transfer Case Gear Oil Service", note: "If applicable" },
          { name: "Front Struts / Shocks" },
          { name: "Rear Struts / Shocks" },
          { name: "Tire Rotation" },
          { name: "Inspect Wiper Blades" },
        ],
      },
      {
        miles: 120000,
        services: [
          { name: "Engine Air Filter Replacement" },
          { name: "Cabin Air Filter Replacement" },
          { name: "Fuel Induction Service" },
          { name: "Brake Fluid Service", note: "Every 2 years or 30k" },
          { name: "Transmission Fluid Service", note: "If applicable" },
          { name: "Tire Rotation & Balance" },
          { name: "Inspect Wiper Blades" },
          { name: "Key Fob Battery" },
        ],
      },
    ],
  };

  const result = buildIntervalProposals(guide);
  check("inference succeeds", result.ok);
  if (result.ok) {
    const byKey = new Map(result.proposals.map((p) => [p.key, p]));

    const engineAir = byKey.get("engine_air");
    check("engine_air → 30000 mi, high", engineAir?.miles === 30000 && engineAir?.confidence === "high");
    check(
      "engine_air appearances exclude the 15k inspect line",
      !!engineAir && !engineAir.appearedAt.includes(15000),
      `appearedAt=${engineAir?.appearedAt}`,
    );

    const cabinAir = byKey.get("cabin_air");
    check("cabin_air → 30000 mi", cabinAir?.miles === 30000);

    const fuel = byKey.get("fuel_system");
    check("fuel_system (Fuel Induction) → 30000 mi", fuel?.miles === 30000);

    const brakeFluid = byKey.get("brake_fluid");
    check(
      "brake_fluid rule → 30000 mi + 24 months, high",
      brakeFluid?.miles === 30000 && brakeFluid?.months === 24 && brakeFluid?.confidence === "high",
    );

    const trans = byKey.get("trans_auto");
    check("trans_auto → 30000 mi with 'If applicable' flag", trans?.miles === 30000 && trans!.flags.includes("If applicable"));

    const rotation = byKey.get("tire_rotation");
    check("tire_rotation (every milestone) → 15000 mi", rotation?.miles === 15000, `got ${rotation?.miles}`);

    const ps = byKey.get("power_steering");
    check(
      "power_steering → 50000 mi with 'Non-electric only' flag",
      ps?.miles === 50000 && ps!.flags.includes("Non-electric only"),
    );

    check("rear_differential → 50000 mi", byKey.get("rear_differential")?.miles === 50000);
    check("front_differential → 50000 mi", byKey.get("front_differential")?.miles === 50000);
    check("transfer_case → 50000 mi", byKey.get("transfer_case")?.miles === 50000);
    check("no bogus 'oil' proposal from gear-oil lines", !byKey.has("oil"));

    const plugs = byKey.get("spark_plugs");
    check("spark_plugs (60k,100k) → 40000 mi medium", plugs?.miles === 40000 && plugs?.confidence === "medium");

    const coolant = byKey.get("coolant");
    check("coolant → 60 months from 'Every 5 years' rule", coolant?.months === 60, `got ${coolant?.months}`);

    const timing = byKey.get("timing_belt");
    check("timing_belt → one-time flagged, low confidence", !!timing && timing.oneTime && timing.confidence === "low");

    const frontShocks = byKey.get("front_shocks");
    check("front_shocks → one-time at 100k", !!frontShocks && frontShocks.oneTime && frontShocks.miles === 100000);

    check(
      "no wiper_blades proposal (inspect-only lines)",
      !byKey.has("wiper_blades"),
    );
    check(
      "no serpentine_belt proposal (inspect-only drive belt lines)",
      !byKey.has("serpentine_belt"),
    );

    check(
      "'Key Fob Battery' surfaced as unmatched",
      result.unmatchedNames.some((n) => n.toLowerCase() === "key fob battery"),
    );
    check(
      "'Review Manufacturers Recommendations' surfaced as unmatched",
      result.unmatchedNames.some((n) => /review manufacturers/i.test(n)),
    );
    check(
      "wiper inspect lines land in flagged as inspect_only",
      result.flagged.some((f) => f.reason === "inspect_only" && /wiper/i.test(f.name)),
    );
    check(
      "no battery proposal from 'Key Fob Battery'",
      !byKey.has("battery"),
    );
  }
}

// ---------------------------------------------------------------------------
console.log("buildIntervalProposals — guardrails");
{
  const thin = buildIntervalProposals({
    milestones: [{ miles: 30000, services: [{ name: "Tire Rotation" }] }],
  });
  check("single milestone → rejected", !thin.ok);

  const nonsense = buildIntervalProposals({
    milestones: [
      { miles: 5000, services: [{ name: "Gvhjk Zxqw" }, { name: "Lorem Ipsum" }] },
      { miles: 10000, services: [{ name: "Dolor Sit Amet" }, { name: "Qwerty Uiop" }] },
    ],
  });
  check("garbled/no-match content → clear error, no proposals", !nonsense.ok);

  // Implausible interval: appears at 200k/400k → 200k gap exceeds bounds.
  const implausible = buildIntervalProposals({
    milestones: [
      { miles: 200000, services: [{ name: "Engine Air Filter Replacement" }, { name: "Tire Rotation" }] },
      { miles: 400000, services: [{ name: "Engine Air Filter Replacement" }, { name: "Oil Change" }] },
    ],
  });
  if (implausible.ok) {
    check(
      "200k-gap interval flagged implausible, not proposed",
      !implausible.proposals.some((p) => p.key === "engine_air") &&
        implausible.flagged.some((f) => f.reason === "implausible"),
    );
  } else {
    // Also acceptable: everything got flagged so no proposals remained.
    check("implausible-only doc rejected outright", true);
  }
}

// ---------------------------------------------------------------------------
console.log("operator overrides (platform-admin interval-import-match)");
{
  const overrides = new Map<string, string>([["key fob battery", "battery"]]);

  check(
    "override maps 'Key Fob Battery' → battery",
    mapImportServiceNameToKey("Key Fob Battery", overrides) === "battery",
  );
  check(
    "override normalizes casing/spacing ('KEY  FOB   Battery')",
    mapImportServiceNameToKey("KEY  FOB   Battery", overrides) === "battery",
  );
  check(
    "no override → still unmatched",
    mapImportServiceNameToKey("Key Fob Battery") === null,
  );
  check(
    "override wins over built-in dictionary",
    mapImportServiceNameToKey("Oil Change", new Map([["oil change", "tire_rotation"]])) ===
      "tire_rotation",
  );
  check(
    "non-overridden names untouched by overrides map",
    mapImportServiceNameToKey("Oil Change", overrides) === "oil",
  );

  const doc: DocExtraction = {
    milestones: [
      {
        miles: 30000,
        services: [{ name: "Key Fob Battery" }, { name: "Oil Change" }, { name: "Tire Rotation" }],
      },
      {
        miles: 60000,
        services: [{ name: "Key Fob Battery" }, { name: "Oil Change" }, { name: "Tire Rotation" }],
      },
    ],
  };

  const without = buildIntervalProposals(doc);
  if (without.ok) {
    check(
      "without override: 'Key Fob Battery' lands in unmatchedNames",
      without.unmatchedNames.includes("Key Fob Battery"),
    );
    check(
      "without override: no battery proposal",
      !without.proposals.some((p) => p.key === "battery"),
    );
  } else {
    check("without override: doc still produced proposals", false, without.error);
  }

  const withOverride = buildIntervalProposals(doc, { overrides });
  if (withOverride.ok) {
    check(
      "with override: battery proposal produced",
      withOverride.proposals.some((p) => p.key === "battery"),
    );
    check(
      "with override: 'Key Fob Battery' no longer in unmatchedNames",
      !withOverride.unmatchedNames.includes("Key Fob Battery"),
    );
  } else {
    check("with override: doc produced proposals", false, withOverride.error);
  }
}

// ---------------------------------------------------------------------------
if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll interval-import checks passed.");
