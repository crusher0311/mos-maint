/**
 * Task #888 — Respect canned-job labor rates on add-to-RO.
 *
 * Run: `npx tsx tests/add-to-ro-labor-rate.smoke.ts`
 *
 * Covers the shared labor-rate resolver used by both add-to-RO routes:
 *  1. Canned source prefers the template's own labor rate.
 *  2. Canned with no positive template rate falls back to the legacy chain.
 *  3. Non-canned sources keep RO → cached → job-rate priority.
 *  4. Zero/missing/garbage rates are treated as absent.
 *  5. needsCachedLaborRate skips the DB read only when the resolver
 *     can't use the cached rate.
 *  6. getJobLaborRate picks the first positive labor line.
 */

import {
  resolveAddToRoLaborRate,
  needsCachedLaborRate,
  getJobLaborRate,
} from "../lib/integrations/protractor/labor-rate";

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  PASS ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}\n    expected ${e}\n    actual   ${a}`);
  }
}

console.log("1) canned prefers template rate");
check(
  "template wins over RO + cached",
  resolveAddToRoLaborRate({ source: "canned", jobLaborRate: 150, roLaborRate: 120, cachedLaborRate: 110 }),
  { rate: 150, rateSource: "template" }
);
check(
  "template wins with only cached present",
  resolveAddToRoLaborRate({ source: "canned", jobLaborRate: 99.5, roLaborRate: 0, cachedLaborRate: 110 }),
  { rate: 99.5, rateSource: "template" }
);

console.log("2) canned without a positive template rate falls back");
check(
  "canned + zero template -> RO rate",
  resolveAddToRoLaborRate({ source: "canned", jobLaborRate: 0, roLaborRate: 120, cachedLaborRate: 110 }),
  { rate: 120, rateSource: "ro" }
);
check(
  "canned + zero template + no RO -> cached",
  resolveAddToRoLaborRate({ source: "canned", jobLaborRate: 0, roLaborRate: 0, cachedLaborRate: 110 }),
  { rate: 110, rateSource: "cached" }
);
check(
  "canned + nothing anywhere -> none",
  resolveAddToRoLaborRate({ source: "canned", jobLaborRate: 0, roLaborRate: 0, cachedLaborRate: 0 }),
  { rate: 0, rateSource: "none" }
);

console.log("3) non-canned keeps legacy priority");
for (const source of ["plan", "failures", "lookup", "autocomplete", undefined, null] as const) {
  check(
    `source=${String(source)}: RO first`,
    resolveAddToRoLaborRate({ source, jobLaborRate: 150, roLaborRate: 120, cachedLaborRate: 110 }),
    { rate: 120, rateSource: "ro" }
  );
}
check(
  "lookup: cached when no RO rate",
  resolveAddToRoLaborRate({ source: "lookup", jobLaborRate: 150, roLaborRate: 0, cachedLaborRate: 110 }),
  { rate: 110, rateSource: "cached" }
);
check(
  "lookup: job rate as last resort",
  resolveAddToRoLaborRate({ source: "lookup", jobLaborRate: 150, roLaborRate: 0, cachedLaborRate: 0 }),
  { rate: 150, rateSource: "fallback" }
);

console.log("4) garbage rates treated as absent");
check(
  "NaN/negative inputs -> none",
  resolveAddToRoLaborRate({ source: "canned", jobLaborRate: NaN, roLaborRate: -5, cachedLaborRate: NaN as any }),
  { rate: 0, rateSource: "none" }
);

console.log("5) needsCachedLaborRate");
check("canned + template rate: skip DB", needsCachedLaborRate({ source: "canned", jobLaborRate: 150, roLaborRate: 0 }), false);
check("canned, no template, no RO: read DB", needsCachedLaborRate({ source: "canned", jobLaborRate: 0, roLaborRate: 0 }), true);
check("lookup + RO rate: skip DB", needsCachedLaborRate({ source: "lookup", jobLaborRate: 150, roLaborRate: 120 }), false);
check("lookup, no RO rate: read DB", needsCachedLaborRate({ source: "lookup", jobLaborRate: 150, roLaborRate: 0 }), true);

console.log("6) getJobLaborRate");
check(
  "first positive labor line wins",
  getJobLaborRate([
    { lineType: "part", unitPrice: 40 },
    { lineType: "labor", unitPrice: 0 },
    { lineType: "labor", unitPrice: 135 },
    { lineType: "labor", unitPrice: 200 },
  ]),
  135
);
check("no labor lines -> 0", getJobLaborRate([{ lineType: "part", unitPrice: 40 }]), 0);
check("undefined lines -> 0", getJobLaborRate(undefined), 0);

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll add-to-RO labor-rate checks passed.");
