/**
 * Smoke test for the central shop distance-unit policy.
 *
 * Run: `npx tsx tests/shop-distance-unit.smoke.ts`
 *
 * Locks in the rule that a shop's unit follows how its own integration reports:
 *   - Miles-only providers (Tekmetric, Shop-Ware) can NEVER be kilometers,
 *     regardless of a stored preference (a misconfiguration that inflates VHI
 *     scores by ~38%).
 *   - Multi-market providers (Protractor) honor the shop's explicit preference.
 *   - Unknown / no provider honors the preference, defaulting to miles.
 *
 * Do not regress to trusting `preferences.distanceUnit` for miles-only shops.
 */

import {
  resolveShopDistanceUnit,
  isDistanceUnitAllowed,
  providerIsMilesOnly,
  getShopProvider,
  MILES_ONLY_PROVIDERS,
} from "../lib/shop-distance-unit";

let failed = 0;

function eq(name: string, got: unknown, want: unknown) {
  if (got === want) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(
      `  ✗ ${name} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`,
    );
  }
}

console.log("shop-distance-unit policy");

// --- providerIsMilesOnly ---
eq("tekmetric is miles-only", providerIsMilesOnly("tekmetric"), true);
eq("shopware is miles-only", providerIsMilesOnly("shopware"), true);
eq("shop-ware (hyphen) is miles-only", providerIsMilesOnly("shop-ware"), true);
eq("TEKMETRIC uppercase is miles-only", providerIsMilesOnly("TEKMETRIC"), true);
eq("protractor is NOT miles-only", providerIsMilesOnly("protractor"), false);
eq("null provider is NOT miles-only", providerIsMilesOnly(null), false);
eq("MILES_ONLY_PROVIDERS has tekmetric", MILES_ONLY_PROVIDERS.has("tekmetric"), true);

// --- getShopProvider (integrationProvider wins, smsProvider fallback) ---
eq(
  "provider from integrationProvider",
  getShopProvider({ integrationProvider: "Tekmetric", smsProvider: "x" }),
  "tekmetric",
);
eq(
  "provider falls back to smsProvider",
  getShopProvider({ smsProvider: "Protractor" }),
  "protractor",
);
eq("provider null when absent", getShopProvider({}), null);

// --- resolveShopDistanceUnit: miles-only providers forced to miles ---
eq(
  "tekmetric + km preference -> miles (the bug we fixed)",
  resolveShopDistanceUnit({
    integrationProvider: "tekmetric",
    preferences: { distanceUnit: "kilometers" },
  }),
  "miles",
);
eq(
  "shopware + km preference -> miles",
  resolveShopDistanceUnit({
    integrationProvider: "shopware",
    preferences: { distanceUnit: "kilometers" },
  }),
  "miles",
);

// --- resolveShopDistanceUnit: protractor honors preference ---
eq(
  "protractor + km preference -> kilometers",
  resolveShopDistanceUnit({
    integrationProvider: "protractor",
    preferences: { distanceUnit: "kilometers" },
  }),
  "kilometers",
);
eq(
  "protractor + miles preference -> miles",
  resolveShopDistanceUnit({
    integrationProvider: "protractor",
    preferences: { distanceUnit: "miles" },
  }),
  "miles",
);
eq(
  "protractor + unset preference -> miles default",
  resolveShopDistanceUnit({ integrationProvider: "protractor" }),
  "miles",
);
eq(
  "legacy settings.distanceUnit honored for protractor",
  resolveShopDistanceUnit({
    integrationProvider: "protractor",
    settings: { distanceUnit: "kilometers" },
  }),
  "kilometers",
);
eq(
  "no provider + km preference -> kilometers",
  resolveShopDistanceUnit({ preferences: { distanceUnit: "kilometers" } }),
  "kilometers",
);
eq("null shopDoc -> miles", resolveShopDistanceUnit(null), "miles");

// --- isDistanceUnitAllowed (write-path guard) ---
eq("km NOT allowed on tekmetric", isDistanceUnitAllowed("tekmetric", "kilometers"), false);
eq("miles allowed on tekmetric", isDistanceUnitAllowed("tekmetric", "miles"), true);
eq("km allowed on protractor", isDistanceUnitAllowed("protractor", "kilometers"), true);
eq("km allowed on unknown provider", isDistanceUnitAllowed(null, "kilometers"), true);

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll shop-distance-unit assertions passed.");
