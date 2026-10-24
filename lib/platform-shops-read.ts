/** Process-local read-only cache. Never cache core/admin authority or failures. */
export class ShopSummaryCache {
  private entries = new Map<string, { expires: number; value: Promise<any[]> }>();
  constructor(private ttl = 30_000, private capacity = 64, private now = Date.now) {}
  read(key: string, load: () => Promise<any[]>): Promise<any[]> {
    const existing = this.entries.get(key);
    if (existing && existing.expires > this.now()) return existing.value;
    if (existing?.expires === Infinity) return existing.value;
    if (this.entries.size >= this.capacity) {
      for (const [k, v] of this.entries) {
        if (v.expires !== Infinity) { this.entries.delete(k); break; }
      }
      if (this.entries.size >= this.capacity) return Promise.reject(new Error("Summary capacity reached"));
    }
    const entry = { expires: Infinity, value: Promise.resolve([]) as Promise<any[]> };
    entry.value = Promise.resolve().then(load).then(value => {
      entry.expires = this.now() + this.ttl;
      // Keep process storage bounded even for unusually large fleets/results.
      if (value.length > 20_000) this.entries.delete(key);
      return value;
    }, error => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    });
    this.entries.set(key, entry);
    return entry.value;
  }
}

export const shopSummaryCache = new ShopSummaryCache();

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
