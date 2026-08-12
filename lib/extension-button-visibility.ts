// Per-user visibility of the Detect Dog buttons the extension injects onto
// SMS pages (Task #1086). Users may HIDE any injected button for themselves;
// they can never reveal a button their shop's feature entitlements don't
// grant. Preferences persist on the users doc (survive reinstalls/devices)
// and resolution intersects with shop feature entitlements server-side so
// content scripts get one authoritative map.
//
// Pure module (no "server-only", no DB) so it stays unit-testable under tsx.

/** Canonical injected-button keys, grouped by SMS provider adapter. */
export const INJECTED_BUTTONS: Record<string, string[]> = {
  tekmetric: ["oil_sticker", "dvi_prefill", "enhance_notes", "add_vhi_recommendations"],
  autoflow: ["oil_sticker", "dvi_prefill", "enhance_notes", "add_vhi_recommendations", "create_ro"],
  shopware: ["oil_sticker"],
};

export const INJECTED_BUTTON_PROVIDERS = Object.keys(INJECTED_BUTTONS);

/**
 * Which shop feature entitlement gates each injected button today. Buttons
 * with a `null` gate are currently injected unconditionally (e.g. the oil
 * sticker print button and Create RO) — visibility preferences may hide
 * them, but there is no entitlement that reveals/locks them here. Keep this
 * in sync with the content-script feature checks (fetchShopFeatures /
 * fetchAutoflowFeatures gating in the adapters).
 */
export const BUTTON_FEATURE_GATE: Record<string, string | null> = {
  oil_sticker: null,
  dvi_prefill: "dvi_prefill",
  enhance_notes: "enhance_notes",
  // "Add VHI recommendations" rides on the dvi_prefill entitlement in every
  // adapter (see tekmetric-content checkAndInjectButton and autoflow
  // injectVhiButtons).
  add_vhi_recommendations: "dvi_prefill",
  create_ro: null,
};

export type InjectedButtonVisibility = Record<string, Record<string, boolean>>;

/**
 * Validate/normalize a client-supplied visibility map. Returns the sanitized
 * map, or null when the input is not an acceptable shape. Unknown providers
 * or button keys are rejected (not silently dropped) so a typo'd client
 * write surfaces as a 400 instead of a mysteriously ignored preference.
 * Only `false` entries are kept — visible is the default, so the stored map
 * is a sparse "hidden set".
 */
export function sanitizeInjectedButtonVisibility(input: unknown): InjectedButtonVisibility | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const out: InjectedButtonVisibility = {};
  for (const [provider, buttons] of Object.entries(input as Record<string, unknown>)) {
    if (!INJECTED_BUTTONS[provider]) return null;
    if (buttons === null || typeof buttons !== "object" || Array.isArray(buttons)) return null;
    for (const [key, val] of Object.entries(buttons as Record<string, unknown>)) {
      if (!INJECTED_BUTTONS[provider].includes(key)) return null;
      if (typeof val !== "boolean") return null;
      if (val === false) {
        (out[provider] ||= {})[key] = false;
      }
    }
  }
  return out;
}

/**
 * Resolve the effective visibility for one provider's injected buttons:
 * entitlement AND user preference. Hiding is allowed (user false wins over
 * an entitled feature); un-gating is not (a feature the shop lacks stays
 * false regardless of the user preference). Buttons default to visible.
 */
export function resolveInjectedButtonVisibility(
  provider: string,
  features: Record<string, boolean> | null | undefined,
  userVisibility: InjectedButtonVisibility | null | undefined,
): Record<string, boolean> {
  const keys = INJECTED_BUTTONS[provider] || [];
  const userMap = (userVisibility && userVisibility[provider]) || {};
  const out: Record<string, boolean> = {};
  for (const key of keys) {
    const gate = BUTTON_FEATURE_GATE[key];
    const entitled = gate === null || gate === undefined ? true : !!(features && features[gate]);
    const userAllows = userMap[key] !== false;
    out[key] = entitled && userAllows;
  }
  return out;
}
