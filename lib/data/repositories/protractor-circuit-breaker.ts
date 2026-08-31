import crypto from "node:crypto";
import { getDb } from "@/lib/mongo";

const COLLECTION = "protractor_circuit_breakers";
const AUTH_COOLDOWN_MS = 5 * 60_000;
const TRANSIENT_COOLDOWN_MS = 30_000;
const PROBE_LEASE_MS = 30_000;
const AUTH_CORRELATION_WINDOW_MS = 60_000;
const PROVIDER_AUTH_CONNECTIONS = 3;
const PROVIDER_TRANSIENT_FAILURES = 3;
// A transport exception has no HTTP response.  It is deliberately distinct
// from auth statuses so it can only contribute to transient provider health.
export const PROTRACTOR_TRANSPORT_FAILURE_STATUS = 599;

type BreakerDocument = {
  _id: string;
  scope: "provider" | "connection";
  connectionHash?: string;
  openUntil?: Date;
  probeUntil?: Date;
  authFailureAt?: Date;
  transientFailures?: number;
  totalResponses?: number;
  successResponses?: number;
  authFailureResponses?: number;
  throttledResponses?: number;
  serverFailureResponses?: number;
  transportFailureResponses?: number;
  otherFailureResponses?: number;
  updatedAt: Date;
};

export type ProtractorGateDecision =
  | { allowed: true; probe: boolean }
  | { allowed: false; reason: string; retryAfterMs: number };

function connectionHash(connectionId: string): string {
  return crypto.createHash("sha256").update(connectionId).digest("hex").slice(0, 32);
}

function connectionKey(connectionId: string): string {
  return `connection:${connectionHash(connectionId)}`;
}

async function claimScope(key: string, now: Date): Promise<ProtractorGateDecision> {
  const db = await getDb();
  const collection = db.collection<BreakerDocument>(COLLECTION);
  const state = await collection.findOne({ _id: key });
  if (!state?.openUntil) return { allowed: true, probe: false };

  if (state.openUntil.getTime() > now.getTime()) {
    return {
      allowed: false,
      reason: `Protractor ${state.scope} circuit breaker open`,
      retryAfterMs: state.openUntil.getTime() - now.getTime(),
    };
  }

  const probeUntil = new Date(now.getTime() + PROBE_LEASE_MS);
  const claimed = await collection.findOneAndUpdate(
    {
      _id: key,
      openUntil: { $lte: now },
      $or: [{ probeUntil: { $exists: false } }, { probeUntil: { $lte: now } }],
    },
    { $set: { probeUntil, updatedAt: now } },
    { returnDocument: "after" },
  );
  if (claimed) return { allowed: true, probe: true };

  return {
    allowed: false,
    reason: `Protractor ${state.scope} circuit breaker awaiting controlled probe`,
    retryAfterMs: Math.max(
      1,
      (state.probeUntil?.getTime() ?? probeUntil.getTime()) - now.getTime(),
    ),
  };
}

async function releaseClaimedProbe(key: string): Promise<void> {
  const db = await getDb();
  await db.collection<BreakerDocument>(COLLECTION).updateOne(
    { _id: key, probeUntil: { $exists: true } },
    { $unset: { probeUntil: "" }, $set: { updatedAt: new Date() } },
  );
}

// Narrow repository seam for deterministic coordination-race tests. Production
// defaults remain the Mongo operations above.
export const __protractorCircuitBreakerTestHooks: {
  claimScope: (key: string, now: Date) => Promise<ProtractorGateDecision>;
  releaseClaimedProbe: (key: string) => Promise<void>;
} = {
  claimScope,
  releaseClaimedProbe,
};

/**
 * Distributed gate used immediately before every live Protractor transport.
 * Connection scope takes precedence so one bad credential cannot consume the
 * single provider-wide recovery probe.
 */
export async function acquireProtractorOutboundGate(
  connectionId: string,
  now = new Date(),
): Promise<ProtractorGateDecision> {
  const key = connectionKey(connectionId);
  const connection = await __protractorCircuitBreakerTestHooks.claimScope(key, now);
  if (!connection.allowed) return connection;
  try {
    const provider = await __protractorCircuitBreakerTestHooks.claimScope("provider", now);
    if (!provider.allowed) {
      // The connection probe was ours, but it cannot be sent because the
      // provider scope won the deny. Roll it back rather than stranding the
      // connection for the complete probe lease.
      if (connection.probe) await __protractorCircuitBreakerTestHooks.releaseClaimedProbe(key);
      return provider;
    }
    return { allowed: true, probe: connection.probe || provider.probe };
  } catch (error) {
    if (connection.probe) await __protractorCircuitBreakerTestHooks.releaseClaimedProbe(key).catch(() => {});
    throw error;
  }
}

export async function recordProtractorResponse(
  connectionId: string,
  statusCode: number,
  retryAfterMs = 0,
  now = new Date(),
): Promise<void> {
  const db = await getDb();
  const collection = db.collection<BreakerDocument>(COLLECTION);
  const connHash = connectionHash(connectionId);
  const connKey = `connection:${connHash}`;
  const responseCounter =
    statusCode >= 200 && statusCode < 400
      ? "successResponses"
      : statusCode === 401 || statusCode === 403
        ? "authFailureResponses"
        : statusCode === 429
          ? "throttledResponses"
          : statusCode === PROTRACTOR_TRANSPORT_FAILURE_STATUS
            ? "transportFailureResponses"
            : statusCode >= 500
              ? "serverFailureResponses"
              : "otherFailureResponses";

  // Privacy-safe per-connection attribution. The document key and
  // connectionHash are one-way fingerprints; credentials and payloads are
  // never retained.
  await collection.updateOne(
    { _id: connKey },
    {
      $setOnInsert: { scope: "connection", connectionHash: connHash },
      $set: { updatedAt: now },
      $inc: { totalResponses: 1, [responseCounter]: 1 },
    },
    { upsert: true },
  );

  if (statusCode >= 200 && statusCode < 400) {
    await Promise.all([
      collection.updateOne(
        {
          _id: connKey,
          $or: [{ openUntil: { $exists: false } }, { probeUntil: { $exists: true } }],
        },
        {
          $unset: { openUntil: "", probeUntil: "", transientFailures: "", authFailureAt: "" },
          $set: { updatedAt: now },
        },
      ),
      collection.updateOne(
        {
          _id: "provider",
          $or: [{ openUntil: { $exists: false } }, { probeUntil: { $exists: true } }],
        },
        { $unset: { openUntil: "", probeUntil: "", transientFailures: "" }, $set: { updatedAt: now } },
      ),
    ]);
    return;
  }

  if (statusCode === 401 || statusCode === 403) {
    await collection.updateOne(
      { _id: connKey },
      {
        $set: {
          scope: "connection",
          connectionHash: connHash,
          authFailureAt: now,
          openUntil: new Date(now.getTime() + AUTH_COOLDOWN_MS),
          updatedAt: now,
        },
        $unset: { probeUntil: "" },
      },
      { upsert: true },
    );

    const recentConnections = await collection.countDocuments({
      scope: "connection",
      authFailureAt: { $gte: new Date(now.getTime() - AUTH_CORRELATION_WINDOW_MS) },
    });
    if (recentConnections >= PROVIDER_AUTH_CONNECTIONS) {
      await collection.updateOne(
        { _id: "provider" },
        {
          $set: {
            scope: "provider",
            openUntil: new Date(now.getTime() + AUTH_COOLDOWN_MS),
            updatedAt: now,
          },
          $unset: { probeUntil: "" },
        },
        { upsert: true },
      );
    }
    return;
  }

  if (statusCode === 429 || statusCode >= 500 || statusCode === PROTRACTOR_TRANSPORT_FAILURE_STATUS) {
    const result = await collection.findOneAndUpdate(
      { _id: "provider" },
      {
        $set: { scope: "provider", updatedAt: now },
        $inc: { transientFailures: 1 },
        $unset: { probeUntil: "" },
      },
      { upsert: true, returnDocument: "after" },
    );
    if ((result?.transientFailures ?? 0) >= PROVIDER_TRANSIENT_FAILURES) {
      const cooldown = Math.max(TRANSIENT_COOLDOWN_MS, retryAfterMs);
      await collection.updateOne(
        { _id: "provider" },
        { $set: { openUntil: new Date(now.getTime() + cooldown), updatedAt: now } },
      );
    }
  }
}