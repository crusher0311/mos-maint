/**
 * Single source of truth for the app's public host / base URL across
 * environments (prod `mos.tools`, qa `qa.mos.tools`, Replit dev, localhost).
 *
 * Intentionally PURE (env-only, no `crypto`/`fs`/React) so it can be shared by
 * server routes, partner-facing URL builders, and modules that also get pulled
 * into the client bundle. Mirrors the precedence partners already see in
 * `buildReportUrl`, so every absolute URL we hand out (report links, hosted
 * icon artwork, etc.) resolves to the same domain.
 */
/** Verified public origins that may safely receive bearer callback URLs. */
export const VERIFIED_PUBLIC_APP_BASE_URLS = [
  "https://mos.tools",
  "https://www.mos.tools",
  "https://qa.mos.tools",
  "https://www.qa.mos.tools",
] as const;

export function resolveAppHost(): string {
  if (process.env.NEXT_PUBLIC_APP_URL) {
    return process.env.NEXT_PUBLIC_APP_URL.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }
  // Canonical per-environment public URL (prod `https://mos.tools`, qa
  // `https://qa.mos.tools`). Preferred over the Render-provided host below so we
  // never hand out the raw `*.onrender.com` address. Must be set correctly per
  // service — a stale value pointing at another environment leaks the wrong host.
  if (process.env.PRODUCTION_URL) {
    return process.env.PRODUCTION_URL.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }
  const renderUrl = process.env.RENDER_EXTERNAL_URL || "";
  if (renderUrl.includes("mos-tools-qa")) return "qa.mos.tools";
  if (renderUrl.includes("mos-tools") && !renderUrl.includes("-qa")) return "mos.tools";
  if (renderUrl) return renderUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (process.env.NEXT_PUBLIC_BASE_URL) {
    return process.env.NEXT_PUBLIC_BASE_URL.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  }
  if (process.env.REPLIT_DEV_DOMAIN) return process.env.REPLIT_DEV_DOMAIN;
  return "localhost:5000";
}

/** Absolute base URL (with scheme, no trailing slash), e.g. `https://mos.tools`. */
export function getAppBaseUrl(): string {
  return `https://${resolveAppHost()}`;
}
