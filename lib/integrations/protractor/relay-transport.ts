import crypto from "node:crypto";
import type { ProtractorRelayConfig } from "./relay-config";
export {
  PROTRACTOR_RELAY_HOSTS,
  preflightProtractorRelayConfig,
  readProtractorRelayConfig,
} from "./relay-config";
export type { ProtractorRelayConfig } from "./relay-config";

const RELAY_REST_TIMEOUT_MS = 60_000;
const RELAY_SOAP_TIMEOUT_MS = 120_000;
const RELAY_OVERHEAD_MS = 5_000;

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