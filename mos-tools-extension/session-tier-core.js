// MOS Tools — pure session-tier logic (tiered session response).
//
// The MOS extension-auth response may now describe the SESSION's trust level
// in addition to the user's ROLE. A session can be issued as "basic"
// (safe shop tools, un-stepped-up) even for a user whose role would normally
// permit writes. Only a "verified"
// session may perform mutations (adding jobs, applying labor rates) and admin
// actions.
//
// This is ORTHOGONAL to the existing role-based `canWrite` check: the
// effective write permission is `canWrite (role) AND session is verified`.
//
// The server may express this two ways (both optional / forward-compatible):
//   * `assurance`: a string tier — "basic" | "verified" (aliases tolerated).
//   * `capabilities`: an array/object listing granted capabilities, e.g.
//     ["read","shop_tool"] for Tekmetric basic, or
//     ["read","shop_tool","write","admin"] for verified.
//
// When the server sends NEITHER (older backends), we fall back to treating the
// session as verified so existing shops are never regressed into read-only.
//
// Loaded three ways (mirrors undo-core.js / telemetry-core.js):
//   * sidepanel.html via a classic <script> — sets global `MosSessionTierCore`;
//   * background.js (ES module) via a side-effect import — reads
//     `globalThis.MosSessionTierCore`;
//   * tsx smoke tests via createRequire (module.exports guard below).
(function (root) {
  const TIER_BASIC = "basic";
  const TIER_VERIFIED = "verified";

  // Normalize a raw assurance string into one of our two tiers, or null if the
  // value is missing / unrecognized (so the caller can fall through to
  // capabilities, then to the safe default).
  function normalizeAssurance(raw) {
    if (raw == null) return null;
    const s = String(raw).trim().toLowerCase();
    if (!s) return null;
    // Verified aliases.
    if (["verified", "full", "elevated", "trusted", "stepped_up", "stepped-up", "high"].includes(s)) {
      return TIER_VERIFIED;
    }
    // Basic / read-only aliases.
    if (["basic", "read_only", "read-only", "readonly", "limited", "low", "unverified"].includes(s)) {
      return TIER_BASIC;
    }
    return null;
  }

  // Coerce a capabilities value (array of strings, or object map of
  // capability -> truthy) into a lowercase Set. Returns null when absent so the
  // caller can distinguish "no capabilities field" from "empty capabilities".
  function toCapabilitySet(capabilities) {
    if (capabilities == null) return null;
    const set = new Set();
    if (Array.isArray(capabilities)) {
      for (const c of capabilities) {
        if (c != null) set.add(String(c).trim().toLowerCase());
      }
      return set;
    }
    if (typeof capabilities === "object") {
      for (const [k, v] of Object.entries(capabilities)) {
        if (v) set.add(String(k).trim().toLowerCase());
      }
      return set;
    }
    return null;
  }

  // Derive the effective session tier + capability flags from a login/auth
  // response (or any object carrying `assurance` / `capabilities`). Precedence:
  //   1. explicit `assurance` string;
  //   2. otherwise infer from `capabilities` (write/admin => verified);
  //   3. otherwise default to verified (backward compatibility).
  //
  // Returns a plain, storage-friendly object:
  //   { tier, isVerified, canUseShopTools, canMutate, canAdmin, source }
  function deriveSessionTier(resp) {
    const src = resp || {};
    const assurance = normalizeAssurance(src.assurance ?? src.sessionAssurance ?? src.tier);
    const caps = toCapabilitySet(src.capabilities ?? src.sessionCapabilities);

    let tier;
    let source;
    if (assurance) {
      tier = assurance;
      source = "assurance";
    } else if (caps) {
      // A capabilities list was sent — trust it. Write/admin => verified.
      tier = caps.has("write") || caps.has("mutate") || caps.has("admin")
        ? TIER_VERIFIED
        : TIER_BASIC;
      source = "capabilities";
    } else {
      // Neither field present — legacy backend. Don't regress existing shops.
      tier = TIER_VERIFIED;
      source = "default";
    }

    const isVerified = tier === TIER_VERIFIED;
    const canUseShopTools = caps
      ? caps.has("shop_tool")
      : isVerified;
    // If a capabilities list is present it further constrains what a verified
    // session may do; a basic session can never mutate/admin regardless.
    const canMutate = isVerified && (caps ? caps.has("write") || caps.has("mutate") : true);
    const canAdmin = isVerified && (caps ? caps.has("admin") : true);

    return {
      tier,
      isVerified,
      canUseShopTools,
      canMutate,
      canAdmin,
      capabilities: caps ? Array.from(caps) : null,
      source,
      shopId: src.session?.shopId ?? src.shopId ?? null,
      smsShopId: src.session?.smsShopId ?? src.smsShopId ?? null,
      provider: src.session?.provider ?? src.provider ?? null,
      expiresAt: src.session?.expiresAt ?? src.expiresAt ?? null,
    };
  }

  // Human-facing label + short description for the session banner.
  function describeSessionTier(tierInfo) {
    const t = tierInfo || {};
    if (t.isVerified) {
      return {
        label: "Verified session",
        variant: "verified",
        prompt: "",
      };
    }
    return {
      label: t.canUseShopTools ? "Tekmetric Basic access" : "Basic access",
      variant: "basic",
      prompt: t.canUseShopTools
        ? "Rendering, analysis, lookups, and entitled printing are available. Sign in to change Tekmetric data or settings."
        : "Sign in to MOS.Tools to use shop tools or make changes.",
    };
  }

  const api = {
    TIER_BASIC,
    TIER_VERIFIED,
    normalizeAssurance,
    toCapabilitySet,
    deriveSessionTier,
    describeSessionTier,
  };

  root.MosSessionTierCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
