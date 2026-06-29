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
export function resolveAppHost(): string {
  if (process.env.NEXT_PUBLIC_APP_URL) {
    return process.env.NEXT_PUBLIC_APP_URL.replace(/^https?:\/\//, "").replace(/\/+$/, "");
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
