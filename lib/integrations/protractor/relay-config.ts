export const PROTRACTOR_RELAY_HOSTS = new Set(["protractor-relay.mos.tools"]);

export type ProtractorRelayConfig =
  | { mode: "direct" }
  | { mode: "relay-read-only" | "relay"; url: URL; secret: string };

function requiredRelayUrl(raw: string | undefined, allowedHosts: ReadonlySet<string>): URL {
  if (!raw) throw new Error("PROTRACTOR_RELAY_URL is required in relay mode");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("PROTRACTOR_RELAY_URL must be a valid URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/relay" ||
    url.search ||
    url.hash ||
    !allowedHosts.has(url.hostname.toLowerCase())
  ) {
    throw new Error("PROTRACTOR_RELAY_URL must be an allowed HTTPS origin with exact path /relay");
  }
  return url;
}

export function readProtractorRelayConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  allowedHosts: ReadonlySet<string> = PROTRACTOR_RELAY_HOSTS,
): ProtractorRelayConfig {
  const mode = env.PROTRACTOR_RELAY_MODE || "direct";
  if (mode !== "direct" && mode !== "relay" && mode !== "relay-read-only") {
    throw new Error("PROTRACTOR_RELAY_MODE must be direct, relay-read-only, or relay");
  }
  if (mode === "direct") return { mode };

  const secret = env.PROTRACTOR_RELAY_HMAC_SECRET;
  if (!secret || new TextEncoder().encode(secret).byteLength < 32) {
    throw new Error("PROTRACTOR_RELAY_HMAC_SECRET must contain at least 32 bytes in relay mode");
  }
  return {
    mode,
    url: requiredRelayUrl(env.PROTRACTOR_RELAY_URL, allowedHosts),
    secret,
  };
}

/** Validate deployment configuration without exposing credentials in logs. */
export function preflightProtractorRelayConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ProtractorRelayConfig {
  const config = readProtractorRelayConfig(env);
  console.info(JSON.stringify({ event: "protractor_relay_preflight", mode: config.mode }));
  return config;
}