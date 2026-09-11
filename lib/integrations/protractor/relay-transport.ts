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

export type ProtractorRelayErrorCode =
  | "busy"
  | "caller_deadline_expired"
  | "caller_disconnected"
  | "invalid_auth"
  | "invalid_body"
  | "invalid_body_encoding"
  | "invalid_deadline"
  | "invalid_headers"
  | "invalid_json"
  | "invalid_method"
  | "invalid_path"
  | "invalid_request"
  | "invalid_type"
  | "method_not_allowed"
  | "not_found"
  | "replayed_request"
  | "replay_journal_full"
  | "relay_required"
  | "request_too_large"
  | "stale_request"
  | "unsupported_media_type"
  | "upstream_body_too_large"
  | "upstream_error"
  | "upstream_response_too_large"
  | "upstream_timeout";

const RELAY_ERROR_CODES = new Set<ProtractorRelayErrorCode>([
  "busy",
  "caller_deadline_expired",
  "caller_disconnected",
  "invalid_auth",
  "invalid_body",
  "invalid_body_encoding",
  "invalid_deadline",
  "invalid_headers",
  "invalid_json",
  "invalid_method",
  "invalid_path",
  "invalid_request",
  "invalid_type",
  "method_not_allowed",
  "not_found",
  "replayed_request",
  "replay_journal_full",
  "relay_required",
  "request_too_large",
  "stale_request",
  "unsupported_media_type",
  "upstream_body_too_large",
  "upstream_error",
  "upstream_response_too_large",
  "upstream_timeout",
]);

export function normalizeProtractorRelayErrorCode(value: string): ProtractorRelayErrorCode {
  return RELAY_ERROR_CODES.has(value as ProtractorRelayErrorCode)
    ? value as ProtractorRelayErrorCode
    : "upstream_error";
}

export function readProtractorRelayErrorCode(
  headers: Record<string, string | string[] | undefined>,
): ProtractorRelayErrorCode | undefined {
  const value = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === "x-relay-error-code",
  )?.[1];
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value[0] : value;
  return normalizeProtractorRelayErrorCode(raw || "");
}

export class RelayTransportError extends Error {
  readonly code: ProtractorRelayErrorCode;
  constructor(code: string, message = "Protractor relay transport failed") {
    super(message);
    this.name = "RelayTransportError";
    this.code = normalizeProtractorRelayErrorCode(code);
  }
}

export type ProtractorEndpointClass =
  | "appointment"
  | "contact"
  | "employee"
  | "inspection"
  | "invoice"
  | "service_item"
  | "service_package"
  | "service_package_template"
  | "soap"
  | "vehicle"
  | "work_order"
  | "other";

const ENDPOINT_CLASSES: Record<string, ProtractorEndpointClass> = {
  appointment: "appointment",
  appointments: "appointment",
  contact: "contact",
  contacts: "contact",
  employee: "employee",
  employees: "employee",
  inspection: "inspection",
  inspections: "inspection",
  invoice: "invoice",
  invoices: "invoice",
  serviceitem: "service_item",
  serviceitems: "service_item",
  servicepackage: "service_package",
  servicepackages: "service_package",
  servicepackagetemplate: "service_package_template",
  servicepackagetemplates: "service_package_template",
  vehicle: "vehicle",
  vehicles: "vehicle",
  workorder: "work_order",
  workorders: "work_order",
};

export function classifyProtractorEndpoint(
  target: string | URL,
  requestType?: "rest" | "soap",
): ProtractorEndpointClass {
  if (requestType === "soap") return "soap";
  let pathname: string;
  try {
    pathname = target instanceof URL
      ? target.pathname
      : new URL(target, "https://integration.protractor.com").pathname;
  } catch {
    return "other";
  }
  const segments = pathname.split("/").filter(Boolean);
  const integrationIndex = segments.findIndex(
    segment => segment.toLowerCase() === "integrationservices",
  );
  const resourceIndex = integrationIndex >= 0 &&
    /^\d+\.\d+$/.test(segments[integrationIndex + 1] || "")
    ? integrationIndex + 2
    : 0;
  const resource = (segments[resourceIndex] || "").toLowerCase();
  if (resource.endsWith(".asmx")) return "soap";
  return ENDPOINT_CLASSES[resource] || "other";
}

export interface RelayRequest {
  type: "rest" | "soap";
  method: string;
  path: string;
  headers: Record<string, string>;
  deadlineAtMs: number;
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
    transport: "relay";
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

/**
 * A timed trial can require relay transport even when the local process has
 * no relay flag (for example, a preview sharing the production Mongo record).
 * Keep this check at the shared transport boundary rather than deriving it
 * from local environment policy.
 */
export function isProtractorRelayConfigured(
  config: ProtractorRelayConfig,
): config is Extract<ProtractorRelayConfig, { mode: "relay" }> {
  return config.mode === "relay";
}

export function assertProtractorRelayConfigured(
  config: ProtractorRelayConfig,
): asserts config is Extract<ProtractorRelayConfig, { mode: "relay" }> {
  if (!isProtractorRelayConfigured(config)) {
    throw new RelayTransportError(
      "relay_required",
      "Protractor relay transport is required for this admission",
    );
  }
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
    deadlineAtMs: nowMs + callerTimeoutMs,
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
    metadata: { mode: config.mode, type, method, requestId, transport: "relay" },
  };
}