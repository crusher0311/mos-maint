import { createHash, randomBytes, randomUUID } from "node:crypto";
import { authenticateAppFueledHook, captureDelivery } from "./data/repositories/appfueled-url-events";
import { HookInputError, normalizeVin, sanitizedEvent, validateUrlEvent } from "./appfueled-url-contract";
import { hookJson, readHookJson } from "./appfueled-hook-http";

export const hashHookToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const newHookToken = () => randomBytes(32).toString("base64url");

// Pre-auth flood protection is process-local and bounded; accepted traffic also
// passes the distributed connection gate in the capture transaction.
const buckets = new Map<string, { count: number; until: number }>();
const ipSalt = randomBytes(32);
function ipDigest(req: Request) {
  // Trust ONLY an edge-overwritten client-IP header. Absent/unverified headers
  // share one conservative bucket; arbitrary X-Forwarded-For is not trusted.
  const name = process.env.APPFUELED_TRUSTED_IP_HEADER;
  const value = name ? req.headers.get(name)?.slice(0, 128) || "unknown" : "unknown";
  return createHash("sha256").update(ipSalt).update(value).digest("hex");
}
function allowIp(key: string) {
  const now = Date.now();
  for (const [id, bucket] of buckets) if (bucket.until < now) buckets.delete(id);
  const bucket = buckets.get(key);
  if (!bucket) {
    if (buckets.size >= 5000) return false;
    buckets.set(key, { count: 1, until: now + 60_000 });
    return true;
  }
  return ++bucket.count <= 240;
}
export const __deps = { authenticateAppFueledHook, captureDelivery, allowIp, ipDigest };

/** This function is the route's complete authentication guard and handler.
 * No external services, payload logs, raw errors or in-memory acknowledgments. */
export async function handleAppFueledUrlWebhook(req: Request, token: string): Promise<Response> {
  const startedAt = Date.now(), correlationId = randomUUID(), receivedAt = new Date(startedAt);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    const ipHash = __deps.ipDigest(req);
    if (!__deps.allowIp(ipHash)) return hookJson({ ok: false, reason: "rate_limited", correlationId }, 429);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return hookJson({ ok: false, reason: "unauthorized", correlationId }, 401);
    const tokenHash = hashHookToken(token);
    const connection = await __deps.authenticateAppFueledHook(tokenHash);
    if (!connection) return hookJson({ ok: false, reason: "unauthorized", correlationId }, 401);
    let payload: unknown = null, vin: string | null = null, vehicleUrl: string | null = null;
    let outcome: "accepted" | "rejected" = "accepted", reason = "accepted", rejectionStatus = 400;
    try {
      payload = await readHookJson(req);
      ({ vin, vehicleUrl } = validateUrlEvent(payload, connection));
    } catch (error) {
      if (!(error instanceof HookInputError)) throw error;
      outcome = "rejected"; reason = error.reason; rejectionStatus = error.status;
      vin = normalizeVin((payload as any)?.data?.vin);
    }
    const result = await __deps.captureDelivery({
      connection, tokenHash, correlationId, receivedAt, vin, payload: sanitizedEvent(payload),
      outcome, reason, vehicleUrl, startedAt, ipHash, deadlineAt: startedAt + 6500,
    });
    const status = result.outcome === "accepted" ? 202
      : result.reason === reason && result.status === 400 ? rejectionStatus : result.status;
    console.info("[AppFueled URL]", { correlationId, outcome: result.outcome,
      reason: result.reason, durationMs: Date.now() - startedAt,
      sourceOrdering: "unknown_no_source_id_or_timestamp" });
    // Only generated correlation/status/reason leave the server, never links,
    // payload identity or credential validity details.
    return hookJson({ ok: result.outcome === "accepted", reason: result.reason, correlationId }, status);
  };
  try {
    return await Promise.race([run(), new Promise<Response>((resolve) => {
      timer = setTimeout(() => resolve(hookJson({ ok: false, reason: "storage_unavailable", correlationId }, 503)), 7000);
    })]);
  } catch {
    return hookJson({ ok: false, reason: "storage_unavailable", correlationId }, 503);
  } finally {
    if (timer) clearTimeout(timer);
  }
}