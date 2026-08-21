// MOS Tools — provider-action grant receipt validation.
//
// The server is the cryptographic verifier/issuer. Extension surfaces use this
// pure helper to carry the signed receipt all the way to the direct provider
// mutation sink and fail closed if its bound provider/action/expiry drift.
(function (root) {
  const PREFIX = "extg_";

  function normalizeProvider(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/^shop[-_]ware$/, "shopware");
  }

  function decodeBase64Url(value) {
    const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    if (typeof atob === "function") {
      return decodeURIComponent(
        Array.from(atob(padded), (char) =>
          `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
        ).join(""),
      );
    }
    if (typeof Buffer !== "undefined") {
      return Buffer.from(padded, "base64").toString("utf8");
    }
    throw new Error("Base64 decoding is unavailable");
  }

  function parseClaims(grant) {
    if (typeof grant !== "string" || !grant.startsWith(PREFIX)) return null;
    const [payload, signature] = grant.slice(PREFIX.length).split(".");
    if (!payload || !signature) return null;
    try {
      return JSON.parse(decodeBase64Url(payload));
    } catch (_) {
      return null;
    }
  }

  function validateReceipt(receipt, expected, nowMs) {
    const exp = expected || {};
    const now = Number.isFinite(nowMs) ? Number(nowMs) : Date.now();
    if (!receipt || typeof receipt !== "object") {
      return { ok: false, error: "Provider authorization receipt missing" };
    }
    const claims = parseClaims(receipt.grant);
    if (!claims || claims.version !== 1) {
      return { ok: false, error: "Provider authorization receipt is invalid" };
    }
    const provider = normalizeProvider(exp.provider);
    const action = String(exp.action || "").trim();
    const receiptProvider = normalizeProvider(receipt.provider);
    const claimProvider = normalizeProvider(claims.provider);
    const receiptAction = String(receipt.providerAction || receipt.action || "").trim();
    const claimAction = String(claims.action || "").trim();
    const claimExpiresMs = Number(claims.expiresAt) * 1000;
    const receiptExpiresMs = Date.parse(String(receipt.expiresAt || ""));
    const issuedMs = Number(claims.issuedAt) * 1000;

    if (
      !provider ||
      !action ||
      receiptProvider !== provider ||
      claimProvider !== provider ||
      receiptAction !== action ||
      claimAction !== action ||
      Number(receipt.shopId) !== Number(claims.shopId) ||
      !Number.isFinite(claimExpiresMs) ||
      !Number.isFinite(receiptExpiresMs) ||
      Math.abs(claimExpiresMs - receiptExpiresMs) > 1000 ||
      claimExpiresMs <= now ||
      claimExpiresMs > now + 125_000 ||
      !Number.isFinite(issuedMs) ||
      issuedMs > now + 30_000 ||
      issuedMs < now - 180_000 ||
      typeof claims.nonce !== "string" ||
      claims.nonce.length < 16
    ) {
      return { ok: false, error: "Provider authorization receipt scope expired or mismatched" };
    }
    if (exp.shopId != null && Number(exp.shopId) !== Number(claims.shopId)) {
      return { ok: false, error: "Provider authorization receipt shop mismatched" };
    }
    if (exp.requireConsumed === true && receipt.consumed !== true) {
      return { ok: false, error: "Provider authorization receipt was not consumed" };
    }
    return { ok: true, claims };
  }

  function requireValidReceipt(receipt, expected, nowMs) {
    const result = validateReceipt(receipt, expected, nowMs);
    if (!result.ok) {
      const error = new Error(result.error);
      error.code = "PROVIDER_ACTION_GRANT_INVALID";
      throw error;
    }
    return result.claims;
  }

  const api = { normalizeProvider, parseClaims, validateReceipt, requireValidReceipt };
  root.MosProviderActionGrantCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);