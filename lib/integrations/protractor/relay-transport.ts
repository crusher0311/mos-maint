import crypto from "node:crypto";

export const PROTRACTOR_RELAY_HOSTS = new Set(["protractor-relay.mos.tools"]);
const RELAY_REST_TIMEOUT_MS = 30_000;
const RELAY_SOAP_TIMEOUT_MS = 120_000;
const RELAY_OVERHEAD_MS = 5_000;

export type ProtractorRelayConfig =
  | { mode: "direct" }
  | { mode: "relay-read-only" | "relay"; url: URL; secret: string };
export class RelayTransportError extends Error {
  readonly code: string;
  constructor(code: string, message = "Protractor relay transport failed") {
    super(message);
    this.name = "RelayTransportError";
    this.code = code;
  }
}

export interface RelayRequest {
  type: "rest" | "soap";
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string;
}

export interface RelayRequestPlan {
  url: URL;
  body: string;
  headers: Record<string, string>;
  timeoutMs: number;
  metadata: {
    mode: "relay-read-only" | "relay";
    type: "rest" | "soap";
    method: string;
    requestId: string;
  };
}

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
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
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

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return entry?.[1];
}

export function classifyProtractorRequest(target: URL, headers: Record<string, string>): "rest" | "soap" {
  const contentType = (headerValue(headers, "content-type") || "").toLowerCase();
  return target.pathname.toLowerCase().endsWith(".asmx") ||
    headerValue(headers, "soapaction") !== undefined ||
    contentType.includes("text/xml") ||
    contentType.includes("application/soap+xml")
    ? "soap"
    : "rest";
}

export function shouldUseProtractorRelay(
  config: ProtractorRelayConfig,
  target: URL,
  method: string,
  headers: Record<string, string>,
): boolean {
  if (config.mode === "relay") return true;
  return config.mode === "relay-read-only" &&
    method === "GET" &&
    classifyProtractorRequest(target, headers) === "rest";
}

export function createProtractorRelayRequest(
  config: Extract<ProtractorRelayConfig, { mode: "relay-read-only" | "relay" }>,
  targetUrl: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  callerTimeoutMs: number,
  nowMs = Date.now(),
  randomBytes: (size: number) => Buffer = crypto.randomBytes,
): RelayRequestPlan {
  const target = new URL(targetUrl);
  if (
    target.protocol !== "https:" ||
    target.hostname.toLowerCase() !== "integration.protractor.com" ||
    target.port ||
    target.username ||
    target.password ||
    target.hash
  ) {
    throw new Error("Relay target must be the Protractor HTTPS origin");
  }
  const type = classifyProtractorRequest(target, headers);
  const payload: RelayRequest = {
    type,
    method,
    path: target.pathname + target.search,
    headers,
    ...(body === undefined ? {} : { body }),
  };
  // This string is the immutable wire representation: hash and write these
  // exact UTF-8 bytes, with no subsequent serialization.
  const relayBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(nowMs / 1000));
  const nonce = randomBytes(24).toString("base64url");
  const requestId = `mos-${randomBytes(18).toString("base64url")}`;
  const bodyHash = crypto.createHash("sha256").update(relayBody, "utf8").digest("hex");
  const canonical = [timestamp, nonce, requestId, "POST", "/relay", bodyHash].join("\n");
  const signature = crypto.createHmac("sha256", config.secret).update(canonical, "utf8").digest("hex");
  const relayDeadline = type === "soap" ? RELAY_SOAP_TIMEOUT_MS : RELAY_REST_TIMEOUT_MS;

  return {
    url: config.url,
    body: relayBody,
    // The caller's deadline is end-to-end. The relay's upstream deadline is a
    // ceiling, not permission to keep a MOS request alive longer.
    timeoutMs: Math.min(callerTimeoutMs, relayDeadline + RELAY_OVERHEAD_MS),
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(relayBody, "utf8")),
      "x-relay-timestamp": timestamp,
      "x-relay-nonce": nonce,
      "x-relay-request-id": requestId,
      "x-relay-signature": `sha256=${signature}`,
    },
    metadata: { mode: config.mode, type, method, requestId },
  };
}