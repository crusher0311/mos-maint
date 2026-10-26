/** Process-local read-only cache. Never cache core/admin authority or failures. */
export class ShopSummaryCache {
  private entries = new Map<string, { expires: number; savedAt?: number; value: Promise<any[]> }>();
  private failures = new Map<string, number>();
  constructor(private ttl = 30_000, private capacity = 64, private now = Date.now) {}
  read(key: string, load: () => Promise<any[]>, allowStale = false): Promise<any[]> {
    const existing = this.entries.get(key);
    if (existing && existing.expires > this.now()) return existing.value;
    if (existing?.expires === Infinity) return existing.value;
    if (allowStale && (this.failures.get(key) || 0) > this.now()) {
      return existing?.savedAt !== undefined && this.now() - existing.savedAt < 300_000
        ? existing.value : Promise.reject(new Error("Summary temporarily unavailable"));
    }
    if (this.entries.size >= this.capacity) {
      for (const [k, v] of this.entries) {
        if (v.expires !== Infinity) { this.entries.delete(k); break; }
      }
      if (this.entries.size >= this.capacity) return Promise.reject(new Error("Summary capacity reached"));
    }
    const entry = { expires: Infinity, savedAt: undefined as number | undefined, value: Promise.resolve([]) as Promise<any[]> };
    entry.value = Promise.resolve().then(load).then(value => {
      entry.expires = this.now() + this.ttl;
      entry.savedAt = this.now();
      this.failures.delete(key);
      // Keep process storage bounded even for unusually large fleets/results.
      if (value.length > 20_000) this.entries.delete(key);
      return value;
    }, error => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      if (allowStale) {
        if (this.failures.size >= this.capacity) this.failures.delete(this.failures.keys().next().value!);
        this.failures.set(key, this.now() + 15_000);
        if (existing?.savedAt !== undefined && this.now() - existing.savedAt < 300_000) {
          existing.expires = this.now() + 15_000;
          this.entries.set(key, existing);
          return existing.value;
        }
      }
      throw error;
    });
    this.entries.set(key, entry);
    return entry.value;
  }
}

export const shopSummaryCache = new ShopSummaryCache();

/** Per-process admission bound: no unbounded admin queue on the shared pool.
 * Driver maxTimeMS remains required: slots are held until work actually ends. */
export class ShopReadLimiter {
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(private concurrency = 2, private capacity = 16) {}
  async run<T>(load: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      if (this.waiting.length >= this.capacity) throw new Error("Shop summaries busy");
      await new Promise<void>((resolve, reject) => {
        const start = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => {
          this.waiting = this.waiting.filter(item => item !== start);
          reject(new Error("Shop summary queue deadline"));
        }, 1500);
        this.waiting.push(start);
      });
    } else this.active++;
    try { return await load(); }
    finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
export const shopReadLimiter = new ShopReadLimiter();
export const fleetTotalsCache = new ShopSummaryCache(60_000, 2);
export const fleetActivityCache = new ShopSummaryCache(300_000, 2);

export function shopIdVariants(ids: (string | number)[]) {
  return [...new Set(ids.flatMap(id => {
    const n = Number(id);
    return String(id).trim() && Number.isFinite(n) ? [String(id), n] : [String(id)];
  }))];
}

/** Only static stage names and durations, never identities/query/error payloads. */
export async function timeShopRead<T>(stage: string, load: () => Promise<T>): Promise<T> {
  const start = performance.now();
  let ok = false;
  try { const value = await load(); ok = true; return value; }
  finally { console.info("[platform-shops-read]", { stage, ok, ms: Math.round(performance.now() - start) }); }
}
