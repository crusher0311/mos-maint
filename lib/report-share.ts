import crypto from "crypto";

const SHARE_SECRET =
  process.env.REPORT_SHARE_SECRET ||
  process.env.STRIPE_WEBHOOK_SECRET ||
  "vhr-share-default-key";
const TOKEN_MAX_AGE_MS = 15 * 24 * 60 * 60 * 1000;

export function generateShareToken(
  vin: string,
  shopId: string,
  expiresAt?: number
): string {
  const exp = expiresAt ?? Date.now() + TOKEN_MAX_AGE_MS;
  const payload = `${vin}:${shopId}:${exp}`;
  const signature = crypto
    .createHmac("sha256", SHARE_SECRET)
    .update(payload)
    .digest("hex")
    .slice(0, 16);
  return Buffer.from(`${payload}:${signature}`).toString("base64url");
}

function resolveAppHost(): string {
  if (process.env.NEXT_PUBLIC_APP_URL) {
    return process.env.NEXT_PUBLIC_APP_URL.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }
  const renderUrl = process.env.RENDER_EXTERNAL_URL || "";
  if (renderUrl.includes("mos-tools-qa")) return "qa.mos.tools";
  if (renderUrl.includes("mos-tools") && !renderUrl.includes("-qa")) return "mos.tools";
  if (renderUrl) return renderUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (process.env.REPLIT_DEV_DOMAIN) return process.env.REPLIT_DEV_DOMAIN;
  return "localhost:5000";
}

export function buildReportUrl(vin: string, shopId: number | string): string {
  const token = generateShareToken(vin.toUpperCase(), String(shopId));
  const host = resolveAppHost();
  return `https://${host}/report/${vin.toUpperCase()}?token=${token}`;
}
