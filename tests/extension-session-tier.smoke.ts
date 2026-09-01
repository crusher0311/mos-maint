// Smoke test for the tiered-session pure logic (Basic read-only vs Verified).
// mos-tools-extension/session-tier-core.js is a UMD-ish classic script (loaded
// by sidepanel.html and imported by background.js); load it here via
// createRequire, the same way extension-undo-core.smoke.ts does.
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  TIER_BASIC,
  TIER_VERIFIED,
  normalizeAssurance,
  deriveSessionTier,
  describeSessionTier,
} = require("../mos-tools-extension/session-tier-core.js");

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`✓ ${name}`);
}

ok("normalizeAssurance maps aliases + unknowns", () => {
  assert.strictEqual(normalizeAssurance("verified"), TIER_VERIFIED);
  assert.strictEqual(normalizeAssurance("Full"), TIER_VERIFIED);
  assert.strictEqual(normalizeAssurance("stepped-up"), TIER_VERIFIED);
  assert.strictEqual(normalizeAssurance("basic"), TIER_BASIC);
  assert.strictEqual(normalizeAssurance("read-only"), TIER_BASIC);
  assert.strictEqual(normalizeAssurance("unverified"), TIER_BASIC);
  assert.strictEqual(normalizeAssurance("wat"), null);
  assert.strictEqual(normalizeAssurance(""), null);
  assert.strictEqual(normalizeAssurance(null), null);
});

ok("legacy response (no fields) defaults to verified — no regression", () => {
  const t = deriveSessionTier({ token: "x", user: {} });
  assert.strictEqual(t.tier, TIER_VERIFIED);
  assert.strictEqual(t.isVerified, true);
  assert.strictEqual(t.canMutate, true);
  assert.strictEqual(t.canAdmin, true);
  assert.strictEqual(t.source, "default");
});

ok("explicit basic assurance => read-only, no mutate/admin", () => {
  const t = deriveSessionTier({ assurance: "basic", capabilities: ["read", "shop_tool"] });
  assert.strictEqual(t.tier, TIER_BASIC);
  assert.strictEqual(t.isVerified, false);
  assert.strictEqual(t.canMutate, false);
  assert.strictEqual(t.canAdmin, false);
  assert.strictEqual(t.canUseShopTools, true);
  assert.strictEqual(t.source, "assurance");
});

ok("explicit verified assurance => full", () => {
  const t = deriveSessionTier({ assurance: "verified" });
  assert.strictEqual(t.isVerified, true);
  assert.strictEqual(t.canMutate, true);
  assert.strictEqual(t.canAdmin, true);
});

ok("capabilities array infers verified from write/admin", () => {
  const t = deriveSessionTier({ capabilities: ["read", "write", "admin"] });
  assert.strictEqual(t.tier, TIER_VERIFIED);
  assert.strictEqual(t.canMutate, true);
  assert.strictEqual(t.canAdmin, true);
  assert.strictEqual(t.source, "capabilities");
});

ok("read-only capabilities => basic, cannot mutate or admin", () => {
  const t = deriveSessionTier({ capabilities: ["read"] });
  assert.strictEqual(t.tier, TIER_BASIC);
  assert.strictEqual(t.canMutate, false);
  assert.strictEqual(t.canAdmin, false);
  assert.strictEqual(t.canUseShopTools, false);
});

ok("write-only capabilities: verified + mutate but NOT admin", () => {
  const t = deriveSessionTier({ capabilities: ["read", "write"] });
  assert.strictEqual(t.isVerified, true);
  assert.strictEqual(t.canMutate, true);
  assert.strictEqual(t.canAdmin, false);
});

ok("assurance wins over capabilities when both present", () => {
  // Server explicitly downgrades to basic even though write cap is listed.
  const t = deriveSessionTier({ assurance: "basic", capabilities: ["read", "write"] });
  assert.strictEqual(t.tier, TIER_BASIC);
  assert.strictEqual(t.canMutate, false);
});

ok("capabilities as object map is honored", () => {
  const t = deriveSessionTier({ capabilities: { read: true, write: false, admin: false } });
  assert.strictEqual(t.tier, TIER_BASIC);
  assert.strictEqual(t.canMutate, false);
});

ok("describeSessionTier labels basic with a verify prompt", () => {
  const basic = describeSessionTier(deriveSessionTier({ assurance: "basic", capabilities: ["read", "shop_tool"] }));
  assert.strictEqual(basic.variant, "basic");
  assert.match(basic.label, /basic/i);
  assert.match(basic.prompt, /printing/i);
  assert.ok(basic.prompt && basic.prompt.length > 0, "basic tier must carry a verify prompt");

  const nonTekmetricBasic = describeSessionTier(
    deriveSessionTier({ assurance: "basic", capabilities: ["read"] }),
  );
  assert.strictEqual(nonTekmetricBasic.label, "Basic access");
  assert.doesNotMatch(nonTekmetricBasic.prompt, /printing/i);

  const verified = describeSessionTier(deriveSessionTier({ assurance: "verified" }));
  assert.strictEqual(verified.variant, "verified");
  assert.strictEqual(verified.prompt, "");
});

console.log(`\nAll ${passed} session-tier assertions passed.`);
