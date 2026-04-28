/**
 * Smoke test for the OE-logo alias / normalization layer.
 *
 * Run: `npx tsx tests/oe-logo.smoke.ts`
 *
 * Verifies that `getOELogoUrl` resolves canonical makes, common aliases,
 * abbreviations, varying whitespace and casing, and returns null for
 * empty / unknown inputs.
 */

import {
  OE_LOGO_MAP,
  clearUnmatchedMakeTally,
  getOELogoUrl,
  getUnmatchedMakeTally,
  normalizeMakeKey,
} from "../lib/oe-logos";

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("OE logo lookup");

// 1. Canonical exact matches still resolve.
ok(
  "canonical TOYOTA resolves",
  getOELogoUrl("TOYOTA") === "/logos/makes/toyota.png",
);
ok(
  "canonical MERCEDES-BENZ resolves",
  getOELogoUrl("MERCEDES-BENZ") === "/logos/makes/mercedes-benz.png",
);
ok(
  "canonical LAND ROVER resolves",
  getOELogoUrl("LAND ROVER") === "/logos/makes/land-rover.png",
);

// 2. Casing / whitespace variants on canonical names.
ok(
  "lowercase 'toyota' resolves",
  getOELogoUrl("toyota") === "/logos/makes/toyota.png",
);
ok(
  "mixed case 'Land Rover' resolves",
  getOELogoUrl("Land Rover") === "/logos/makes/land-rover.png",
);
ok(
  "extra whitespace '  toyota  ' resolves",
  getOELogoUrl("  toyota  ") === "/logos/makes/toyota.png",
);
ok(
  "double-spaced 'LAND  ROVER' resolves",
  getOELogoUrl("LAND  ROVER") === "/logos/makes/land-rover.png",
);

// 3. Aliases called out by the task.
ok(
  "alias MERCEDES -> mercedes-benz.png",
  getOELogoUrl("MERCEDES") === "/logos/makes/mercedes-benz.png",
);
ok(
  "alias 'Mercedes Benz' -> mercedes-benz.png",
  getOELogoUrl("Mercedes Benz") === "/logos/makes/mercedes-benz.png",
);
ok(
  "alias VW -> volkswagen.png",
  getOELogoUrl("VW") === "/logos/makes/volkswagen.png",
);
ok(
  "alias LANDROVER -> land-rover.png",
  getOELogoUrl("LANDROVER") === "/logos/makes/land-rover.png",
);
ok(
  "alias 'ROLLS ROYCE' -> rolls-royce.png",
  getOELogoUrl("ROLLS ROYCE") === "/logos/makes/rolls-royce.png",
);
ok(
  "alias 'MINI COOPER' -> mini.png",
  getOELogoUrl("MINI COOPER") === "/logos/makes/mini.png",
);
ok(
  "alias CHEVY -> chevrolet.png",
  getOELogoUrl("Chevy") === "/logos/makes/chevrolet.png",
);
ok(
  "alias ALFAROMEO -> alfa-romeo.png",
  getOELogoUrl("alfaromeo") === "/logos/makes/alfa-romeo.png",
);
ok(
  "misspelling VOLKSWAGON -> volkswagen.png",
  getOELogoUrl("Volkswagon") === "/logos/makes/volkswagen.png",
);

// 4. Negative cases.
ok("null make -> null", getOELogoUrl(null) === null);
ok("undefined make -> null", getOELogoUrl(undefined) === null);
ok("empty string -> null", getOELogoUrl("") === null);
ok(
  "unknown make 'Yugo' -> null",
  getOELogoUrl("Yugo") === null,
);

// 5. normalizeMakeKey leaves unknowns upper-cased and trimmed (so a future
//    map addition will Just Work).
ok(
  "normalizeMakeKey trims + uppercases unknowns",
  normalizeMakeKey("  yugo  ") === "YUGO",
);

// 6. Sanity: every canonical key in OE_LOGO_MAP also resolves via getOELogoUrl
//    (guards against accidental key drift).
for (const key of Object.keys(OE_LOGO_MAP)) {
  if (getOELogoUrl(key) !== OE_LOGO_MAP[key]) {
    failed += 1;
    console.error(`  ✗ canonical key "${key}" failed to resolve`);
  }
}

// 7. Unmatched-make tally records misses without spamming on every render.
clearUnmatchedMakeTally();

// Silence the warn-once log for these intentional miss calls so the smoke
// output stays clean.
const realWarn = console.warn;
console.warn = () => {};
try {
  getOELogoUrl("Yugo");
  getOELogoUrl("yugo");
  getOELogoUrl("  YUGO  ");
  getOELogoUrl("Studebaker");
} finally {
  console.warn = realWarn;
}

const tally = getUnmatchedMakeTally();
const yugo = tally.find((e) => e.key === "YUGO");
const stude = tally.find((e) => e.key === "STUDEBAKER");
ok(
  "tally has YUGO entry with count 3 (deduped via normalization)",
  !!yugo && yugo.count === 3,
  yugo ? `count=${yugo.count}` : "missing entry",
);
ok(
  "tally tracks raw input samples for YUGO",
  !!yugo && yugo.samples.includes("Yugo") && yugo.samples.includes("yugo"),
);
ok(
  "tally has STUDEBAKER entry with count 1",
  !!stude && stude.count === 1,
);
ok(
  "tally is sorted by count desc (YUGO before STUDEBAKER)",
  tally.findIndex((e) => e.key === "YUGO") <
    tally.findIndex((e) => e.key === "STUDEBAKER"),
);

// Empty / null / undefined inputs must NOT pollute the tally.
clearUnmatchedMakeTally();
getOELogoUrl(null);
getOELogoUrl(undefined);
getOELogoUrl("");
ok(
  "null/undefined/empty inputs do not record into the tally",
  getUnmatchedMakeTally().length === 0,
);

// Canonical hits must NOT pollute the tally either.
getOELogoUrl("TOYOTA");
getOELogoUrl("Mercedes Benz");
ok(
  "canonical & alias hits do not record into the tally",
  getUnmatchedMakeTally().length === 0,
);

clearUnmatchedMakeTally();
ok(
  "clearUnmatchedMakeTally empties the tally",
  getUnmatchedMakeTally().length === 0,
);

if (failed === 0) {
  console.log("\nAll OE logo lookup checks passed.");
  process.exit(0);
} else {
  console.error(`\n${failed} OE logo lookup check(s) failed.`);
  process.exit(1);
}
