/** Pure inbound contract. Deliberately independent of the outgoing partner APIs. */
export const MAX_HOOK_BYTES = 16 * 1024;
export const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;
export const CONNECTION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class HookInputError extends Error {
  constructor(public reason: string, public status = 400) { super(reason); }
}

/** Exact DNS names only: no wildcards, IP literals, single-label/private names. */
export function approvedHost(value: unknown): string {
  if (typeof value !== "string" || value.length > 253) throw new HookInputError("invalid_allowed_host");
  const host = value.toLowerCase();
  if (host !== host.trim() || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ||
      /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|example|onion|arpa)$/.test(host) ||
      /(?:^|\.)(?:localtest\.me|lvh\.me|nip\.io|sslip\.io)$/.test(host)) {
    throw new HookInputError("invalid_allowed_host");
  }
  return host;
}

export function safeVehicleUrl(value: unknown, hosts: string[]): string {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(value)) {
    throw new HookInputError("unsafe_vehicle_url");
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new HookInputError("unsafe_vehicle_url"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) {
    throw new HookInputError("unsafe_vehicle_url");
  }
  let host: string;
  try { host = approvedHost(url.hostname); } catch { throw new HookInputError("unsafe_vehicle_url"); }
  if (!hosts.includes(host)) throw new HookInputError("unapproved_vehicle_host");
  // No DNS lookup or fetch. Operators attest that the exact approved host is a
  // public customer site; these are stored candidates, not runnable redirects.
  return url.href;
}

export function normalizeVin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const vin = value.trim().toUpperCase();
  return VIN_PATTERN.test(vin) ? vin : null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function validateUrlEvent(payload: unknown, connection: {
  connectionId: string; incomingShopId: number; allowedHosts: string[];
}) {
  const data = object(object(payload)?.data);
  if (!data) throw new HookInputError("invalid_data_envelope");
  if (data.event_name !== "vhi_url") throw new HookInputError("unsupported_event");
  if (data.connection_id !== connection.connectionId) throw new HookInputError("connection_mismatch");
  if (typeof data.mos_shop_id !== "number" || !Number.isSafeInteger(data.mos_shop_id) || data.mos_shop_id <= 0) {
    throw new HookInputError("invalid_incoming_shop_id");
  }
  if (data.mos_shop_id !== connection.incomingShopId) throw new HookInputError("shop_mismatch");
  const vin = normalizeVin(data.vin);
  if (!vin) throw new HookInputError("invalid_vin");
  return { vin, vehicleUrl: safeVehicleUrl(data.vhi_url, connection.allowedHosts) };
}

/** Allowlist projection: never retain arbitrary fields, malformed strings, URL
 * paths/query/fragment, or request credentials even in rejected JSON. */
export function sanitizedEvent(payload: unknown): Record<string, unknown> {
  const data = object(object(payload)?.data);
  if (!data) return { data: "[invalid or unavailable]", extraFields: "omitted" };
  return {
    data: {
      event_name: data.event_name === "vhi_url" ? "vhi_url" : "[invalid]",
      connection_id: "[bound connection shown on receipt]",
      mos_shop_id: typeof data.mos_shop_id === "number" && Number.isSafeInteger(data.mos_shop_id)
        ? data.mos_shop_id : "[invalid]",
      vin: normalizeVin(data.vin) ?? "[invalid]",
      vhi_url: typeof data.vhi_url === "string" ? "[redacted; accepted candidate in restricted URL inspection]" : "[invalid]",
    },
    extraFields: "omitted",
    sourceOrdering: "unknown: no source event ID or timestamp",
  };
}

export function parseConnectionInput(body: unknown) {
  const b = object(body);
  if (!b || typeof b.connectionId !== "string" || !CONNECTION_PATTERN.test(b.connectionId)) throw new HookInputError("invalid_connection_id");
  if (typeof b.mosShopId !== "number" || !Number.isInteger(b.mosShopId) || b.mosShopId <= 0 || b.mosShopId > 2147483647) throw new HookInputError("invalid_mos_shop_id");
  if (typeof b.incomingShopId !== "number" || !Number.isSafeInteger(b.incomingShopId) || b.incomingShopId <= 0) throw new HookInputError("invalid_incoming_shop_id");
  if (b.shopIdNamespace !== "mos" && b.shopIdNamespace !== "provider") throw new HookInputError("confirm_shop_id_namespace");
  if (b.shopIdNamespace === "mos" && b.incomingShopId !== b.mosShopId) throw new HookInputError("mos_namespace_id_mismatch");
  if (typeof b.namespaceConfirmation !== "string" || b.namespaceConfirmation.trim().length < 10 || b.namespaceConfirmation.length > 500) throw new HookInputError("namespace_confirmation_required");
  if (!Array.isArray(b.allowedHosts) || !b.allowedHosts.length || b.allowedHosts.length > 10) throw new HookInputError("allowed_hosts_required");
  if (b.hostConfirmed !== true) throw new HookInputError("confirm_public_customer_hosts");
  return {
    connectionId: b.connectionId, mosShopId: b.mosShopId, incomingShopId: b.incomingShopId,
    shopIdNamespace: b.shopIdNamespace as "mos" | "provider",
    namespaceConfirmation: b.namespaceConfirmation.trim(),
    allowedHosts: [...new Set(b.allowedHosts.map(approvedHost))],
  };
}