const intEnv = (name, fallback, minimum, maximum) => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
};

export function loadConfig() {
  const secret = process.env.RELAY_HMAC_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new Error("RELAY_HMAC_SECRET must be set and contain at least 32 bytes");
  }

  let upstream = new URL("https://integration.protractor.com");
  if (process.env.RELAY_UPSTREAM !== undefined) {
    if (process.env.NODE_ENV !== "test") {
      throw new Error("RELAY_UPSTREAM is only permitted when NODE_ENV=test");
    }
    upstream = new URL(process.env.RELAY_UPSTREAM);
  }

  const clockSkewSeconds = intEnv("HMAC_CLOCK_SKEW_SECONDS", 60, 5, 300);
  const replayTtlSeconds = intEnv("REPLAY_TTL_SECONDS", 120, 10, 600);
  if (replayTtlSeconds < clockSkewSeconds) {
    throw new Error("REPLAY_TTL_SECONDS must be at least HMAC_CLOCK_SKEW_SECONDS");
  }
  return {
    secret,
    upstream,
    host: process.env.HOST || "0.0.0.0",
    port: intEnv("PORT", 8080, 1, 65535),
    requestBodyLimit: intEnv("REQUEST_BODY_LIMIT_BYTES", 1_048_576, 1024, 10_485_760),
    responseBodyLimit: intEnv("RESPONSE_BODY_LIMIT_BYTES", 5_242_880, 1024, 52_428_800),
    restTimeoutMs: intEnv("REST_TIMEOUT_MS", 30_000, 100, 120_000),
    soapTimeoutMs: intEnv("SOAP_TIMEOUT_MS", 120_000, 100, 180_000),
    requestTimeoutMs: intEnv("REQUEST_TIMEOUT_MS", 10_000, 1000, 120_000),
    clockSkewSeconds,
    replayTtlSeconds,
    replayMaxEntries: intEnv("REPLAY_MAX_ENTRIES", 100_000, 100, 1_000_000),
    maxConcurrentUpstreams: intEnv("MAX_CONCURRENT_UPSTREAMS", 32, 1, 1000),
    maxConcurrentIngress: intEnv("MAX_CONCURRENT_INGRESS", 64, 1, 2000),
    replayJournalMaxBytes: intEnv("REPLAY_JOURNAL_MAX_BYTES", 10_485_760, 65_536, 1_073_741_824),
    replayJournalPath: process.env.REPLAY_JOURNAL_PATH || "/var/lib/protractor-relay/replay.journal"
  };
}