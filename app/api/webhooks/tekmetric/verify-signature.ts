import type { NextRequest } from "next/server";

/**
 * Step 3b — HMAC signature verification framework (extracted from route.ts).
 *
 * Lives in a sibling module (not the route file) because Next's generated
 * route types forbid non-handler exports from route.ts, and the smoke test
 * (tests/tekmetric-webhook-signature.smoke.ts) needs to import this seam.
 *
 * Default behavior: if `TEKMETRIC_WEBHOOK_SIGNING_SECRET` is unset, we skip
 * verification entirely (matches pre-3b behavior — accept everything).
 *
 * When the secret IS set, we require a valid HMAC-SHA256 signature in the
 * configured header. The header name and algorithm are env-tunable so we can
 * adjust once Tekmetric confirms the exact format (the captured headers in
 * `tekmetric_webhook_logs.headers` make this introspectable).
 *
 * Returns null if OK, or an error string for a 401 response.
 */
export function verifySignature(rawBody: string, req: NextRequest): string | null {
  const secret = process.env.TEKMETRIC_WEBHOOK_SIGNING_SECRET;
  if (!secret) return null; // verification disabled

  const headerName = (process.env.TEKMETRIC_WEBHOOK_SIGNATURE_HEADER || "x-tekmetric-signature").toLowerCase();
  const algo = process.env.TEKMETRIC_WEBHOOK_SIGNATURE_ALGO || "sha256";
  // Encoding can be "hex" (default) or "base64" — Tekmetric's exact format will
  // be confirmed from the captured headers (3b introspection) before enabling.
  const encoding = (process.env.TEKMETRIC_WEBHOOK_SIGNATURE_ENCODING || "hex").toLowerCase();
  const provided = req.headers.get(headerName);
  if (!provided) return `missing signature header: ${headerName}`;

  const crypto = require("crypto");
  const expected = crypto.createHmac(algo, secret).update(rawBody).digest(encoding);

  // Strip a "sha256=" / "hmac-sha256=" prefix if present (common formats).
  const normalized = provided.includes("=") && provided.indexOf("=") < provided.length - 1
    ? provided.substring(provided.indexOf("=") + 1)
    : provided;

  try {
    const a = encoding === "base64"
      ? Buffer.from(expected, "base64")
      : Buffer.from(expected, "hex");
    const b = encoding === "base64"
      ? Buffer.from(normalized, "base64")
      : Buffer.from(normalized, "hex");
    if (a.length !== b.length || a.length === 0) return "signature length mismatch";
    if (!crypto.timingSafeEqual(a, b)) return "signature mismatch";
    return null;
  } catch (err: any) {
    return `signature parse error: ${err?.message || "unknown"}`;
  }
}

/** Back-compat alias for the old route-exported test seam name. */
export const __verifySignature = verifySignature;
