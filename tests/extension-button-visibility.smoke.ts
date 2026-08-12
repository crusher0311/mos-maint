// Smoke test for per-user injected-button visibility (Task #1086).
// Pure logic — sanitize (PUT validation) and resolve (entitlement
// intersection: hiding allowed, un-gating not). Standalone tsx + node:assert.
import assert from "node:assert";
import {
  INJECTED_BUTTONS,
  BUTTON_FEATURE_GATE,
  sanitizeInjectedButtonVisibility,
  resolveInjectedButtonVisibility,
} from "../lib/extension-button-visibility";

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`✓ ${name}`);
}

ok("every provider's buttons have a feature-gate entry", () => {
  for (const [provider, keys] of Object.entries(INJECTED_BUTTONS)) {
    for (const key of keys) {
      assert.ok(key in BUTTON_FEATURE_GATE, `${provider}.${key} missing from BUTTON_FEATURE_GATE`);
    }
  }
});

// ---------- sanitize ----------
ok("sanitize accepts a valid sparse map and drops true entries", () => {
  const out = sanitizeInjectedButtonVisibility({
    tekmetric: { enhance_notes: false, dvi_prefill: true },
    autoflow: { create_ro: false },
  });
  assert.deepStrictEqual(out, {
    tekmetric: { enhance_notes: false },
    autoflow: { create_ro: false },
  });
});

ok("sanitize accepts empty object", () => {
  assert.deepStrictEqual(sanitizeInjectedButtonVisibility({}), {});
});

ok("sanitize rejects non-objects", () => {
  assert.strictEqual(sanitizeInjectedButtonVisibility(null), null);
  assert.strictEqual(sanitizeInjectedButtonVisibility("x"), null);
  assert.strictEqual(sanitizeInjectedButtonVisibility([]), null);
  assert.strictEqual(sanitizeInjectedButtonVisibility(42), null);
});

ok("sanitize rejects unknown providers and buttons", () => {
  assert.strictEqual(sanitizeInjectedButtonVisibility({ mitchell: {} }), null);
  assert.strictEqual(sanitizeInjectedButtonVisibility({ tekmetric: { bogus_btn: false } }), null);
  // create_ro is autoflow-only today
  assert.strictEqual(sanitizeInjectedButtonVisibility({ tekmetric: { create_ro: false } }), null);
});

ok("sanitize rejects non-boolean values and non-object provider maps", () => {
  assert.strictEqual(sanitizeInjectedButtonVisibility({ tekmetric: { enhance_notes: "no" } }), null);
  assert.strictEqual(sanitizeInjectedButtonVisibility({ tekmetric: ["enhance_notes"] }), null);
  assert.strictEqual(sanitizeInjectedButtonVisibility({ tekmetric: null }), null);
});

// ---------- resolve ----------
const fullFeatures = { dvi_prefill: true, enhance_notes: true, oil_sticker: true };

ok("defaults: everything entitled + no prefs → all visible", () => {
  const out = resolveInjectedButtonVisibility("tekmetric", fullFeatures, {});
  assert.deepStrictEqual(out, {
    oil_sticker: true,
    dvi_prefill: true,
    enhance_notes: true,
    add_vhi_recommendations: true,
  });
});

ok("user can hide an entitled button", () => {
  const out = resolveInjectedButtonVisibility("tekmetric", fullFeatures, {
    tekmetric: { enhance_notes: false },
  });
  assert.strictEqual(out.enhance_notes, false);
  assert.strictEqual(out.dvi_prefill, true);
});

ok("user cannot reveal an unentitled button", () => {
  const out = resolveInjectedButtonVisibility("tekmetric", { dvi_prefill: false, enhance_notes: false }, {
    tekmetric: { enhance_notes: true as unknown as boolean },
  });
  assert.strictEqual(out.enhance_notes, false, "entitlement must win");
  assert.strictEqual(out.dvi_prefill, false);
  assert.strictEqual(out.add_vhi_recommendations, false, "rides on dvi_prefill gate");
});

ok("ungated buttons (oil_sticker, create_ro) visible without features", () => {
  const out = resolveInjectedButtonVisibility("autoflow", {}, {});
  assert.strictEqual(out.oil_sticker, true);
  assert.strictEqual(out.create_ro, true);
  assert.strictEqual(out.dvi_prefill, false);
});

ok("ungated buttons can still be hidden by the user", () => {
  const out = resolveInjectedButtonVisibility("shopware", {}, { shopware: { oil_sticker: false } });
  assert.deepStrictEqual(out, { oil_sticker: false });
});

ok("null/undefined features and prefs are safe", () => {
  const out = resolveInjectedButtonVisibility("tekmetric", null, undefined);
  assert.strictEqual(out.oil_sticker, true);
  assert.strictEqual(out.dvi_prefill, false);
});

ok("prefs for one provider don't leak into another", () => {
  const out = resolveInjectedButtonVisibility("autoflow", fullFeatures, {
    tekmetric: { oil_sticker: false },
  });
  assert.strictEqual(out.oil_sticker, true);
});

ok("unknown provider resolves to empty map", () => {
  assert.deepStrictEqual(resolveInjectedButtonVisibility("mitchell", fullFeatures, {}), {});
});

console.log(`\nAll ${passed} extension-button-visibility smoke tests passed.`);
