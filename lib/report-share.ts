import crypto from "crypto";
import { resolveAppHost } from "@/lib/app-host";

const TOKEN_MAX_AGE_MS = 15 * 24 * 60 * 60 * 1000;

function getShareSecret(): string {
  const secret = process.env.REPORT_SHARE_SECRET;
  if (!secret) {
    throw new Error(
      "REPORT_SHARE_SECRET is required but not set. " +
        "Set this environment variable to a strong random value before starting the server."
    );
  }
  return secret;
}

export function generateShareToken(
  vin: string,
  shopId: string,
  expiresAt?: number
): string {
  const secret = getShareSecret();
  const exp = expiresAt ?? Date.now() + TOKEN_MAX_AGE_MS;
  const payload = `${vin}:${shopId}:${exp}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex")
    .slice(0, 16);
  return Buffer.from(`${payload}:${signature}`).toString("base64url");
}

/**
 * Verify a share token.
 *
 * During the transition from the legacy STRIPE_WEBHOOK_SECRET signing key to
 * the dedicated REPORT_SHARE_SECRET, tokens signed with either key are
 * accepted so previously issued links (≤15-day max age) remain valid. Remove
 * the STRIPE_WEBHOOK_SECRET fallback arm after 2026-09-16 once all
 * outstanding links have aged out.
 */
export function verifyShareToken(
  token: string
): { vin: string; shopId: string } | null {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf-8");
    const parts = decoded.split(":");
    if (parts.length !== 4) return null;
    const [vin, shopId, expiresStr, signature] = parts;
    const expiresAt = parseInt(expiresStr, 10);
    if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null;
    const payload = `${vin}:${shopId}:${expiresAt}`;

    // Primary key — required; throws if REPORT_SHARE_SECRET is unset.
    const primaryExpected = crypto
      .createHmac("sha256", getShareSecret())
      .update(payload)
      .digest("hex")
      .slice(0, 16);
    if (signature === primaryExpected) return { vin, shopId };

    // Transition fallback: accept tokens signed with the legacy Stripe key so
    // links issued before the REPORT_SHARE_SECRET rollout keep working for
    // their remaining lifetime (≤15 days). Remove after 2026-09-16.
    const legacySecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (legacySecret) {
      const legacyExpected = crypto
        .createHmac("sha256", legacySecret)
        .update(payload)
        .digest("hex")
        .slice(0, 16);
      if (signature === legacyExpected) return { vin, shopId };
    }

    return null;
  } catch {
    return null;
  }
}

export function buildReportUrl(
  vin: string,
  shopId: number | string,
  expiresAt?: number,
): string {
  const token = generateShareToken(vin.toUpperCase(), String(shopId), expiresAt);
  const host = resolveAppHost();
  return `https://${host}/report/${vin.toUpperCase()}?token=${token}`;
}
