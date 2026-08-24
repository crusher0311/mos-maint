/**
 * Slow-query analyzer — buffered capture + instrumentation seams (task #1161).
 *
 * Follows the API usage tracker pattern: slow operations are pushed into a
 * bounded in-memory buffer and flushed in batches to the Postgres
 * `slow_queries` table (never back into Mongo hot paths). Capture can never
 * slow the system: the buffer is hard-capped (overflow drops records),
 * flushing is fire-and-forget, and the kill switch means the instrumented
 * clients do no extra work at all.
 *
 * Instrumentation seams:
 *   - `mongoMonitorEnabled()` + `attachMongoSlowQueryMonitor(client)` — used
 *     by lib/mongo.ts (driver command monitoring on the singleton client).
 *   - `instrumentPgClientForSlowQueries(client)` — used by lib/db/drizzle.ts
 *     (times each postgres-js query from first await to settle).
 */
import {
  isIgnoredMongoCommand,
  mongoCommandCollection,
  sanitizeMongoCommand,
  sanitizeSqlText,
  shapeHash,
  slowQuerySampleRate,
  slowQuerySource,
  slowQueryThresholdMs,
  slowQueryTrackingEnabled,
  sqlOperation,
  sqlTargetTable,
  type SlowQueryRecord,
} from "./core";

const FLUSH_INTERVAL_MS = 15000;
const FLUSH_BATCH_SIZE = 50;
const BUFFER_HARD_CAP = 500;
const STARTED_MAP_CAP = 5000;

let buffer: SlowQueryRecord[] = [];
let lastFlush = Date.now();
let flushing = false;
let droppedSinceLastFlush = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

// Test seam. `insert` defaults to a lazy import of the repository so this
// module never creates an import cycle with lib/db/drizzle.ts.
export const __deps = {
  insert: null as null | ((records: SlowQueryRecord[]) => Promise<number>),
  now: () => Date.now(),
  flushIntervalMs: FLUSH_INTERVAL_MS,
};

/**
 * Every process that captures anything schedules its own unref'd timer
 * flush, so a lone below-batch-size capture is guaranteed to be persisted
 * within one interval — no follow-up query or cron visit to THIS instance
 * required (web autoscaling means the cron endpoint only ever flushes the
 * replica that happens to serve it).
 */
function scheduleTimerFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushSlowQueryBuffer();
  }, __deps.flushIntervalMs);
  // Never keep the process alive for the analyzer.
  if (typeof (flushTimer as any)?.unref === "function") (flushTimer as any).unref();
}

async function defaultInsert(records: SlowQueryRecord[]): Promise<number> {
  const repo = await import("@/lib/data/repositories/slow-queries");
  return repo.insertSlowQueryRecords(records);
}

/** Exposed for tests. */
export function __getBuffer(): SlowQueryRecord[] {
  return buffer;
}
export function __resetBuffer(): void {
  buffer = [];
  droppedSinceLastFlush = 0;
  lastFlush = __deps.now();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

/**
 * Record one slow operation. Never throws; drops on overflow. Recursion
 * guard: captures targeting the slow_queries table itself are ignored so
 * the flush's own insert can never generate new captures.
 */
export function recordSlowQuery(record: SlowQueryRecord): void {
  try {
    if (!slowQueryTrackingEnabled()) return;
    if (record.target === "slow_queries") return;
    const rate = slowQuerySampleRate();
    if (rate < 1 && Math.random() >= rate) return;
    if (buffer.length >= BUFFER_HARD_CAP) {
      droppedSinceLastFlush++;
      return;
    }
    buffer.push(record);
    if (
      buffer.length >= FLUSH_BATCH_SIZE ||
      __deps.now() - lastFlush > __deps.flushIntervalMs
    ) {
      // Fire-and-forget: the caller's hot path never awaits the flush.
      void flushSlowQueryBuffer();
    } else {
      scheduleTimerFlush();
    }
  } catch {
    // Capture must never break the caller.
  }
}

export async function flushSlowQueryBuffer(): Promise<void> {
  if (flushing || buffer.length === 0) return;
  flushing = true;
  const toFlush = buffer;
  buffer = [];
  lastFlush = __deps.now();
  const dropped = droppedSinceLastFlush;
  droppedSinceLastFlush = 0;
  try {
    const insert = __deps.insert ?? defaultInsert;
    await insert(toFlush);
    if (dropped > 0) {
      console.warn(`[SlowQuery] buffer overflow: dropped ${dropped} records`);
    }
  } catch (err: any) {
    // Re-buffer (bounded) so a transient PG hiccup doesn't lose the batch.
    buffer = [...toFlush, ...buffer].slice(0, BUFFER_HARD_CAP);
    console.error("[SlowQuery] flush failed:", String(err?.message || err));
  } finally {
    flushing = false;
  }
}

// ---------------------------------------------------------------------------
// Mongo instrumentation (driver command monitoring)
// ---------------------------------------------------------------------------

export function mongoMonitorEnabled(): boolean {
  return slowQueryTrackingEnabled();
}

interface StartedCommand {
  commandName: string;
  command: Record<string, unknown>;
}

/**
 * Attach commandStarted/Succeeded/Failed listeners to a MongoClient created
 * with `monitorCommands: true`. Command bodies are held (by reference, no
 * copying) in a bounded map until the matching completion event; shapes are
 * only computed for operations that actually crossed the threshold.
 */
export function attachMongoSlowQueryMonitor(client: {
  on: (event: string, listener: (ev: any) => void) => unknown;
}): void {
  const started = new Map<number, StartedCommand>();

  client.on("commandStarted", (ev: any) => {
    try {
      if (isIgnoredMongoCommand(ev.commandName)) return;
      if (started.size >= STARTED_MAP_CAP) return; // shed under storm
      started.set(ev.requestId, {
        commandName: ev.commandName,
        command: ev.command,
      });
    } catch {
      /* never break the driver */
    }
  });

  const onDone = (ev: any, failed: boolean) => {
    try {
      const entry = started.get(ev.requestId);
      if (entry) started.delete(ev.requestId);
      if (!slowQueryTrackingEnabled()) return;
      const durationMs = Number(ev.duration ?? 0);
      if (durationMs < slowQueryThresholdMs()) return;
      const commandName = entry?.commandName || ev.commandName || "unknown";
      if (isIgnoredMongoCommand(commandName)) return;
      const target = entry
        ? mongoCommandCollection(commandName, entry.command)
        : null;
      const shape = entry
        ? sanitizeMongoCommand(commandName, entry.command)
        : commandName;
      const shapeText = failed ? `${shape} [FAILED]` : shape;
      let rowsReturned: number | null = null;
      const firstBatch = ev?.reply?.cursor?.firstBatch;
      if (Array.isArray(firstBatch)) rowsReturned = firstBatch.length;
      recordSlowQuery({
        ts: new Date(),
        db: "mongo",
        operation: commandName.slice(0, 40),
        target,
        shape: shapeText,
        shapeHash: shapeHash("mongo", target, shape),
        durationMs,
        rowsReturned,
        source: slowQuerySource(),
      });
    } catch {
      /* never break the driver */
    }
  };

  client.on("commandSucceeded", (ev: any) => onDone(ev, false));
  client.on("commandFailed", (ev: any) => onDone(ev, true));
}

// ---------------------------------------------------------------------------
// Postgres instrumentation (postgres-js client wrapper)
// ---------------------------------------------------------------------------

/**
 * Patch a postgres-js Query object in place so the time between its first
 * `.then` attach (i.e. the await, when postgres-js actually executes) and
 * settlement is measured. In-place patching (not a Proxy) keeps chained
 * builder methods like `.values()` / `.simple()` — which return `this` —
 * on the instrumented object.
 */
function timeQuery(q: any, text: string): any {
  if (!q || typeof q.then !== "function") return q;
  const origThen = q.then.bind(q);
  let startedAt = 0;
  let settled = false;
  const settle = () => {
    if (settled || !startedAt) return;
    settled = true;
    const durationMs = Date.now() - startedAt;
    if (durationMs < slowQueryThresholdMs()) return;
    const shape = sanitizeSqlText(text);
    const target = sqlTargetTable(shape);
    if (target === "slow_queries") return;
    recordSlowQuery({
      ts: new Date(),
      db: "pg",
      operation: sqlOperation(shape),
      target,
      shape,
      shapeHash: shapeHash("pg", target, shape),
      durationMs,
      source: slowQuerySource(),
    });
  };
  q.then = function patchedThen(onFulfilled?: any, onRejected?: any) {
    if (!startedAt) startedAt = Date.now();
    return origThen(
      (res: any) => {
        try {
          settle();
        } catch {
          /* never break the query */
        }
        return onFulfilled ? onFulfilled(res) : res;
      },
      (err: any) => {
        try {
          settle();
        } catch {
          /* never break the query */
        }
        if (onRejected) return onRejected(err);
        throw err;
      },
    );
  };
  return q;
}

/**
 * Wrap the shared postgres-js client so every query — both the tagged
 * template form (sql`...`) and `sql.unsafe(...)` used by Drizzle — is
 * timed. When the kill switch is on this returns the client unchanged, so
 * the disabled hot path is exactly the stock client.
 */
export function instrumentPgClientForSlowQueries<T extends object>(client: T): T {
  if (!slowQueryTrackingEnabled()) return client;
  return wrapSqlClient(client);
}

// Methods whose callback receives a fresh SQL client that must itself be
// instrumented: sql.begin(fn) / sql.begin(opts, fn) hands a transaction-
// scoped client to fn (this is what Drizzle transactions use), and the
// transaction client's sql.savepoint(fn) nests the same way.
const CALLBACK_CLIENT_METHODS = new Set(["begin", "savepoint"]);

function wrapSqlClient<T extends object>(client: T): T {
  const handler: ProxyHandler<any> = {
    apply(target, thisArg, args) {
      const q = Reflect.apply(target, thisArg, args);
      // Tagged-template call: args[0] is the strings array. Helper calls
      // (sql(values) fragments) produce non-thenable builders; timeQuery
      // passes those through untouched.
      const first = args[0];
      const text = Array.isArray(first) ? first.join("$?") : String(first ?? "");
      return timeQuery(q, text);
    },
    get(target, prop, receiver) {
      if (prop === "unsafe") {
        const orig = Reflect.get(target, prop, target);
        if (typeof orig !== "function") return orig;
        return function unsafeWrapped(this: any, ...args: any[]) {
          const q = orig.apply(target, args);
          return timeQuery(q, String(args[0] ?? ""));
        };
      }
      if (typeof prop === "string" && CALLBACK_CLIENT_METHODS.has(prop)) {
        const orig = Reflect.get(target, prop, target);
        if (typeof orig !== "function") return orig;
        return function callbackClientWrapped(this: any, ...args: any[]) {
          // Replace every function argument (the transaction/savepoint body)
          // with one that hands the callback an instrumented client, so
          // queries inside transactions are timed too. Non-function args
          // (options string/object) pass through untouched.
          const wrappedArgs = args.map((a) =>
            typeof a === "function"
              ? (txSql: any, ...rest: any[]) =>
                  a(
                    txSql && (typeof txSql === "function" || typeof txSql === "object")
                      ? wrapSqlClient(txSql)
                      : txSql,
                    ...rest,
                  )
              : a,
          );
          return orig.apply(target, wrappedArgs);
        };
      }
      const value = Reflect.get(target, prop, target);
      if (typeof value === "function") return value.bind(target);
      return value;
    },
  };
  return new Proxy(client, handler) as T;
}

/** Exposed for tests. */
export const __wrapSqlClient = wrapSqlClient;
