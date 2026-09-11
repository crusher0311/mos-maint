/**
 * Task #1274 extension parity checks.
 *
 * This is intentionally source-level coverage: it verifies the extension
 * cannot regress to a generic one-hour audit add or a client-authoritative
 * source payload without touching a provider or production data.
 *
 * Run: `npx tsx tests/extension-estimate-recommendation.smoke.ts`
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const sidepanel = fs.readFileSync("mos-tools-extension/sidepanel.js", "utf8");
const background = fs.readFileSync("mos-tools-extension/background.js", "utf8");
const extensionAdd = fs.readFileSync("app/api/extension/jobs/add-to-ro/route.ts", "utf8");
const rehydrate = fs.readFileSync(
  "app/api/extension/jobs/rehydrate-recommendation/route.ts",
  "utf8",
);

const checks: Array<[string, boolean]> = [
  [
    "audit buttons resolve against the shared recommendation endpoint",
    /\/api\/estimate-assist\/resolve-recommendation/.test(sidepanel) &&
      /estimate-audit-review-btn/.test(sidepanel),
  ],
  [
    "resolver request carries finding and vehicle context",
    /suggestedJobTitle:[\s\S]*?suggestedJobId:[\s\S]*?vehicle:\s*(?:estimateAuditVehicle\([^)]*\)|auditVehicle)/.test(sidepanel),
  ],
  [
    "thin candidate selection performs a selected-detail preview",
    /mode:\s*'preview'/.test(sidepanel) &&
      /selection:\s*\{\s*source:\s*\{\s*\.\.\.source\s*\}/.test(sidepanel) &&
      /state\.candidates\[candidateIndex\]\s*=\s*hydratedCandidate/.test(sidepanel),
  ],
  [
    "audit lookup distinguishes unavailable from a verified no-match",
    /Existing-source lookup is temporarily unavailable/.test(sidepanel) &&
      /No suitable existing shop job or vehicle-history match was found/.test(sidepanel),
  ],
  [
    "candidate review requires explicit selection and confirmation",
    /estimate-audit-confirm-btn/.test(sidepanel) &&
      /Confirm selected existing job/.test(sidepanel) &&
      /data-candidate-index/.test(sidepanel),
  ],
  [
    "candidate preview renders source metadata, lines and prices",
    /estimateCandidateSourceLabel/.test(sidepanel) &&
      /estimateCandidateLines/.test(sidepanel) &&
      /estimateLinePrice/.test(sidepanel),
  ],
  [
    "selected writes carry an opaque audit source identity",
    /state\.auditSelection\s*=\s*auditSelection/.test(sidepanel) &&
      /auditSelection \? \{ auditSelection \}/.test(sidepanel) &&
      /auditFinding \? \{ auditFinding \}/.test(sidepanel),
  ],
  [
    "extension Protractor write rehydrates selected source server-side",
    /rehydrateRecommendationSelection/.test(extensionAdd) &&
      /rawAuditSelection/.test(extensionAdd) &&
      /recommendation\.lines\.map/.test(extensionAdd),
  ],
  [
    "direct Tekmetric write rehydrates before provider mutation",
    /rehydrate-recommendation/.test(background) &&
      /if \(auditSelection\)/.test(background) &&
      /createTekmetricJob\([\s\S]*message\.auditSelection/.test(background),
  ],
  [
    "Shop-Ware selected sources import by verified source ID only",
    /action:\s*'SW_IMPORT_SERVICE'/.test(background) &&
      /selectedSource\?\.kind !== 'canned'/.test(background) &&
      /SHOPWARE_SOURCE_UNSUPPORTED/.test(background) &&
      !/bestMatch/.test(background),
  ],
  [
    "rehydration route enforces feature and provider scope",
    /validateExtensionToken/.test(rehydrate) &&
      /requireExtensionPrincipalScope/.test(rehydrate) &&
      /getFeatureEntitlements/.test(rehydrate) &&
      /rehydrateRecommendationSelection/.test(rehydrate),
  ],
  [
    "audit add no longer creates an implicit one-hour generic job",
    !/estimate-audit-add-to-ro-btn/.test(sidepanel) &&
      !/laborItems:\s*\[\{ name: title, hours: 1 \}\]/.test(sidepanel),
  ],
];

console.log("extension estimate recommendation parity");
let failures = 0;
for (const [name, passed] of checks) {
  if (passed) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}`);
  }
}

assert.equal(failures, 0, `${failures} extension parity check(s) failed`);
console.log("\nAll extension estimate recommendation checks passed.");