// Task #804 smoke tests: protection-plan eligibility detection, lapse-risk
// computation and status resolution (pure module — no DB, no server-only).
//
// Run: npm run test:protection-plan
import {
  computeLapseRisk,
  detectProviderEligibility,
  getProviderBrandTokens,
  resolveProtectionPlanStatus,
  serviceNameMatchesBrand,
} from "../lib/plan-build/protection-plan";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  PASS ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}`);
  }
}

console.log("[protection-plan] brand tokens");
{
  const tokens = getProviderBrandTokens({ name: "BG", templateId: "bg-lpp" });
  check("BG -> ['bg']", tokens.length === 1 && tokens[0] === "bg");

  const tokens2 = getProviderBrandTokens({ name: "BG Products", templateId: null });
  check("generic word 'Products' filtered", tokens2.length === 1 && tokens2[0] === "bg");

  const tokens3 = getProviderBrandTokens({ name: "Lifetime Protection Plan", templateId: "bg-lpp" });
  check("templateId contributes 'bg' when name is all-generic", tokens3.includes("bg"));

  check(
    "single-letter words dropped",
    !getProviderBrandTokens({ name: "X Chemicals" }).includes("x"),
  );
}

console.log("[protection-plan] brand matching (word boundaries)");
{
  const tokens = ["bg"];
  check("matches 'BG EPR Engine Performance Restoration'", serviceNameMatchesBrand("BG EPR Engine Performance Restoration", tokens));
  check("matches 'bg 44k fuel system cleaner'", serviceNameMatchesBrand("bg 44k fuel system cleaner", tokens));
  check("matches parenthesized '(BG) Trans Service'", serviceNameMatchesBrand("(BG) Trans Service", tokens));
  check("does NOT match 'Air bag inspection'", !serviceNameMatchesBrand("Air bag inspection", ["bg"]));
  check("does NOT match 'Bagged coolant'", !serviceNameMatchesBrand("Bagged coolant", ["bg"]));
  check("empty name never matches", !serviceNameMatchesBrand("", tokens));
}

console.log("[protection-plan] eligibility detection");
{
  const provider = { name: "BG", templateId: "bg-lpp" };
  const elig = detectProviderEligibility(provider, [
    "Oil Change",
    "BG MOA Engine Oil Supplement",
    "bg moa engine oil supplement", // dupe, different case
    "Brake Fluid Exchange",
  ]);
  check("eligible when branded job present", elig.eligible === true);
  check("matches deduped case-insensitively", elig.matches.length === 1);

  const none = detectProviderEligibility(provider, ["Oil Change", "Tire Rotation"]);
  check("not eligible without branded history", none.eligible === false && none.matches.length === 0);

  const empty = detectProviderEligibility(provider, []);
  check("empty history -> not eligible", empty.eligible === false);
}

console.log("[protection-plan] lapse risk");
{
  const provider = {
    intervals: {
      engine_oil: { miles: 5000, months: 6 },
      transmission_fluid: { miles: 30000, months: null },
    },
  };
  const risk = computeLapseRisk(provider, [
    { serviceKey: "engine_oil", title: "Engine Oil & Filter" },
    { serviceKey: "cabin_air_filter", title: "Cabin Air Filter" }, // not provider-required
    { serviceKey: "engine_oil", title: "dupe row" },
  ]);
  check("at risk when a required key is overdue", risk.atRisk === true);
  check("only provider-required overdue items counted, deduped", risk.overdueRequired.length === 1);
  check("title carried through", risk.overdueRequired[0].title === "Engine Oil & Filter");

  const ok = computeLapseRisk(provider, [
    { serviceKey: "cabin_air_filter", title: "Cabin Air Filter" },
  ]);
  check("not at risk when no required key overdue", ok.atRisk === false);

  const emptyOverdue = computeLapseRisk(provider, []);
  check("empty overdue bucket -> not at risk", emptyOverdue.atRisk === false);
}

console.log("[protection-plan] status resolution");
{
  check("enrolled + atRisk -> at_risk", resolveProtectionPlanStatus({ enrolled: true, atRisk: true, eligible: true }) === "at_risk");
  check("enrolled, on schedule -> enrolled", resolveProtectionPlanStatus({ enrolled: true, atRisk: false, eligible: true }) === "enrolled");
  check("not enrolled + eligible -> eligible", resolveProtectionPlanStatus({ enrolled: false, atRisk: false, eligible: true }) === "eligible");
  check("not enrolled, no history -> none", resolveProtectionPlanStatus({ enrolled: false, atRisk: false, eligible: false }) === "none");
  check("atRisk ignored when not enrolled", resolveProtectionPlanStatus({ enrolled: false, atRisk: true, eligible: false }) === "none");
}

if (failures > 0) {
  console.error(`\n[protection-plan] ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\n[protection-plan] all checks passed");
