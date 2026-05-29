/**
 * Smoke test for the central shop distance-unit policy.
 *
 * Run: `npx tsx tests/shop-distance-unit.smoke.ts`
 *
 * Locks in the rule that a shop's unit follows WHERE THE SHOP IS:
 *   - Known country is authoritative: US -> miles, Canada -> kilometers. This
 *     OVERRIDES any stored preference (the historical mislabel that inflated /
 *     deflated VHI scores by ~38%).
 *   - Tekmetric/Shop-Ware are NOT US-only: a Tekmetric shop confirmed to be in
 *     Canada must resolve to kilometers (shops 86 "Access Automotive" and 155
 *     "Equipfix Auto Repair" are real Ontario Tekmetric shops).
 *   - Unknown country on a single-market miles provider -> miles (safe default).
 *   - Unknown country on a multi-market provider -> honor explicit preference.
 *
 * Do not regress to "Tekmetric/Shop-Ware = always miles regardless of country".
 */

import {
  resolveShopDistanceUnit,
  resolveShopCountry,
  inferCountryFromAddress,
  unitForCountry,
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

// --- providerIsMilesOnly (fallback signal only) ---
eq("tekmetric is single-market miles", providerIsMilesOnly("tekmetric"), true);
eq("shopware is single-market miles", providerIsMilesOnly("shopware"), true);
eq("shop-ware (hyphen) is single-market miles", providerIsMilesOnly("shop-ware"), true);
eq("TEKMETRIC uppercase", providerIsMilesOnly("TEKMETRIC"), true);
eq("protractor is NOT single-market", providerIsMilesOnly("protractor"), false);
eq("null provider is NOT single-market", providerIsMilesOnly(null), false);
eq("MILES_ONLY_PROVIDERS has tekmetric", MILES_ONLY_PROVIDERS.has("tekmetric"), true);

// --- getShopProvider ---
eq("provider from integrationProvider", getShopProvider({ integrationProvider: "Tekmetric", smsProvider: "x" }), "tekmetric");
eq("provider falls back to smsProvider", getShopProvider({ smsProvider: "Protractor" }), "protractor");
eq("provider null when absent", getShopProvider({}), null);

// --- inferCountryFromAddress ---
eq("ON province -> CA", inferCountryFromAddress({ state: "ON" }), "CA");
eq("OK state -> US", inferCountryFromAddress({ state: "OK" }), "US");
eq("Canadian postal -> CA", inferCountryFromAddress({ zip: "K7R 3Z9" }), "CA");
eq("Canadian postal no space -> CA", inferCountryFromAddress({ zip: "L0M1S0" }), "CA");
eq("US zip -> US", inferCountryFromAddress({ zip: "73099" }), "US");
eq("US zip+4 -> US", inferCountryFromAddress({ zip: "73099-1234" }), "US");
eq("empty address -> null", inferCountryFromAddress({}), null);
eq("garbage -> null", inferCountryFromAddress({ state: "ZZ", zip: "????" }), null);

// --- unitForCountry ---
eq("CA -> kilometers", unitForCountry("CA"), "kilometers");
eq("US -> miles", unitForCountry("US"), "miles");

// --- resolveShopCountry (geo.country wins, then inference) ---
eq("geo.country US", resolveShopCountry({ geo: { country: "US" } }), "US");
eq("geo.country Canada word", resolveShopCountry({ geo: { country: "Canada" } }), "CA");
eq("geo state inference", resolveShopCountry({ geo: { state: "QC" } }), "CA");
eq("no geo -> null", resolveShopCountry({ integrationProvider: "tekmetric" }), null);

// --- resolveShopDistanceUnit: KNOWN COUNTRY IS AUTHORITATIVE ---
eq(
  "Canadian Tekmetric shop (shop 86) -> kilometers, even with stored miles",
  resolveShopDistanceUnit({
    integrationProvider: "tekmetric",
    preferences: { distanceUnit: "miles" },
    geo: { country: "CA", state: "ON", zip: "K7R 3Z9" },
  }),
  "kilometers",
);
eq(
  "US Tekmetric shop (shop 63) -> miles, even with stored kilometers",
  resolveShopDistanceUnit({
    integrationProvider: "tekmetric",
    preferences: { distanceUnit: "kilometers" },
    geo: { country: "US", state: "OK", zip: "73099" },
  }),
  "miles",
);
eq(
  "Canadian Tekmetric inferred from state only -> kilometers",
  resolveShopDistanceUnit({
    integrationProvider: "tekmetric",
    geo: { state: "ON" },
  }),
  "kilometers",
);

// --- resolveShopDistanceUnit: UNKNOWN COUNTRY fallbacks ---
eq(
  "unknown-country Tekmetric -> miles (safe default)",
  resolveShopDistanceUnit({
    integrationProvider: "tekmetric",
    preferences: { distanceUnit: "kilometers" },
  }),
  "miles",
);
eq(
  "unknown-country shopware -> miles (safe default)",
  resolveShopDistanceUnit({ integrationProvider: "shopware" }),
  "miles",
);
eq(
  "protractor + km preference -> kilometers",
  resolveShopDistanceUnit({ integrationProvider: "protractor", preferences: { distanceUnit: "kilometers" } }),
  "kilometers",
);
eq(
  "protractor + unset -> miles default",
  resolveShopDistanceUnit({ integrationProvider: "protractor" }),
  "miles",
);
eq(
  "protractor honors known CA country over preference",
  resolveShopDistanceUnit({ integrationProvider: "protractor", preferences: { distanceUnit: "miles" }, geo: { country: "CA" } }),
  "kilometers",
);
eq("null shopDoc -> miles", resolveShopDistanceUnit(null), "miles");

// --- isDistanceUnitAllowed (write-path guard, takes the shop doc) ---
eq("km NOT allowed on US Tekmetric (known country)", isDistanceUnitAllowed({ integrationProvider: "tekmetric", geo: { country: "US" } }, "kilometers"), false);
eq("km allowed on CA Tekmetric (known country)", isDistanceUnitAllowed({ integrationProvider: "tekmetric", geo: { country: "CA" } }, "kilometers"), true);
eq("miles NOT allowed on CA Tekmetric (known country)", isDistanceUnitAllowed({ integrationProvider: "tekmetric", geo: { country: "CA" } }, "miles"), false);
eq("km NOT allowed on unknown-country Tekmetric (safe default)", isDistanceUnitAllowed({ integrationProvider: "tekmetric" }, "kilometers"), false);
eq("km allowed on unknown-country Protractor", isDistanceUnitAllowed({ integrationProvider: "protractor" }, "kilometers"), true);
eq("km allowed on unknown provider", isDistanceUnitAllowed({}, "kilometers"), true);

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll shop-distance-unit assertions passed.");
