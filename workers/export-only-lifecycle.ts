/** No database, provider, backfill or queue clients may be imported here. */
export interface ExportConsumer {
  waitUntilReady(): Promise<unknown>;
  isRunning(): boolean;
  client: Promise<{ status: string }>;
  close(): Promise<void>;
}

export function validateExportWorkerEnvironment(env: Record<string, string | undefined>): boolean {
  if (env.PROTRACTOR_EXPORTS_ENABLED !== "1") return false;
  if (!env.REDIS_URL) throw new Error("Export worker requires REDIS_URL");
  if (!/^[a-f\d]{64}$/i.test(env.PROTRACTOR_EXPORT_ENCRYPTION_KEY ?? ""))
    throw new Error("Export worker encryption key is missing or invalid");
  if (!env.MONGODB_URI && !(env.MONGODB_USERNAME && env.MONGODB_PASSWORD))
    throw new Error("Export worker Mongo configuration is missing");
  if (!env.PROTRACTOR_EXPORT_DATABASE_URL || !env.PROTRACTOR_EXPORT_DATABASE_ROLE)
    throw new Error("Export worker dedicated PostgreSQL configuration is missing");
  if ((env.PROTRACTOR_CACHE_PG_CANONICAL === "1" || env.IDENTITY_PG_CANONICAL === "1") &&
      !env.DATAONE_DATABASE_URL && !env.DATABASE_URL)
    throw new Error("Export worker source PostgreSQL configuration is missing");
  return true;
}

export interface ExportWorkerDependencies {
  preflight(): Promise<void>;
  createConsumer(queue: "protractor-export", concurrency: 1): ExportConsumer;
  heartbeat(): Promise<void>;
  disconnect(): Promise<void>;
  schedule(callback: () => void): unknown;
  unschedule(timer: unknown): void;
  warn(): void;
}

/** Exposes stop before startup so SIGTERM during preflight cannot start a consumer. */
export function exportOnlyLifecycle(deps: ExportWorkerDependencies) {
  let stopped = false;
  let started = false;
  let consumer: ExportConsumer | undefined;
  let timer: unknown;
  let beat: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let starting: Promise<void> | undefined;

  function heartbeat(): Promise<void> {
    if (stopped || beat) return beat ?? Promise.resolve();
    beat = (async () => {
      if (!consumer?.isRunning()) return;
      const client = await consumer.client;
      if (!stopped && client.status === "ready") await deps.heartbeat();
    })().catch(() => deps.warn()).finally(() => { beat = undefined; });
    return beat;
  }

  return {
    start(): Promise<void> {
      if (started) return Promise.reject(new Error("Export worker already started"));
      started = true;
      starting = (async () => {
        await deps.preflight();
        if (stopped) return;
        consumer = deps.createConsumer("protractor-export", 1);
        await consumer.waitUntilReady();
        if (stopped) return;
        await heartbeat();
        if (!stopped) timer = deps.schedule(() => { void heartbeat(); });
      })();
      return starting;
    },
    stop(): Promise<void> {
      stopped = true;
      if (timer !== undefined) { deps.unschedule(timer); timer = undefined; }
      if (!closing) closing = (async () => {
        // Drain an existing consumer immediately, including during Redis startup.
        // A preflight still pending cannot create a consumer after stopped=true.
        try {
          await consumer?.close();
          await starting?.catch(() => {});
          await beat;
        } finally { await deps.disconnect(); }
      })();
      return closing;
    },
  };
}
