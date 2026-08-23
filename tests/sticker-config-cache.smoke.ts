/**
 * Smoke test: extension sticker-config SWR cache (task #1076).
 *
 * The right-click interval dropdown must never hang on a sticker-config
 * fetch. These tests exercise mos-tools-extension/lib/sticker-config-cache.js
 * with a faked fetch/storage and assert:
 *   - fresh hit: served instantly, NO network call
 *   - stale hit: served instantly (last-known-good) + exactly one background refresh
 *   - cold miss: bounded by ONE end-to-end deadline even when the underlying
 *     fetch stalls (simulating 401 retry sleeps / silent re-auth), and the
 *     read rejects within the bound so the caller falls back to defaults
 *   - late-landing stalled fetch still warms the cache afterwards
 *   - invalidate: next read FORCES a live refresh (edited intervals show up),
 *     with last-known-good served only if that refresh fails
 *   - concurrent cold reads dedupe into one fetch
 *   - persistence: entries round-trip through the injected storage
 */

import { createStickerConfigCache } from "../mos-tools-extension/lib/sticker-config-cache.js";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}`);
  }
}

const quietLog = { warn: () => {}, error: () => {}, log: () => {} } as unknown as Console;

function makeStorage(initial: Record<string, any> = {}) {
  const store: Record<string, any> = { ...initial };
  return {
    store,
    storageGet: async (key: string) => store[key],
    storageSet: async (key: string, value: any) => {
      store[key] = JSON.parse(JSON.stringify(value));
    },
  };
}

async function main() {
  // ---- fresh hit: no network -------------------------------------------
  {
    console.log("fresh hit served without a network call");
    let fetchCalls = 0;
    let t = 1_000_000;
    const { storageGet, storageSet } = makeStorage();
    const cache = createStickerConfigCache({
      fetchConfig: async () => {
        fetchCalls += 1;
        return { config: { intervals: { synthetic: { mileage: 5000, months: 6 } } }, enabled: true };
      },
      storageGet,
      storageSet,
      now: () => t,
      log: quietLog,
    });
    const first = await cache.get("42", "tekmetric");
    check("cold miss fetches once", fetchCalls === 1 && first.fromCache === false);
    t += 60_000; // 1 min later, well inside the 10-min TTL
    const second = await cache.get("42", "tekmetric");
    check("fresh hit does not fetch", fetchCalls === 1);
    check("fresh hit served from cache", second.fromCache === true && !second.stale);
    check("config round-trips", second.config.intervals.synthetic.mileage === 5000);
  }

  // ---- stale hit: instant serve + one background refresh ----------------
  {
    console.log("stale hit serves last-known-good instantly and refreshes behind");
    let fetchCalls = 0;
    let t = 1_000_000;
    const { storageGet, storageSet } = makeStorage();
    const cache = createStickerConfigCache({
      fetchConfig: async () => {
        fetchCalls += 1;
        return { config: { v: fetchCalls }, enabled: true };
      },
      storageGet,
      storageSet,
      now: () => t,
      log: quietLog,
    });
    await cache.get("42", "tekmetric");
    t += 11 * 60_000; // beyond the 10-min TTL
    const stale = await cache.get("42", "tekmetric");
    check("stale read served from cache", stale.fromCache === true && stale.stale === true);
    check("stale read returned OLD value instantly", stale.config.v === 1);
    await new Promise((r) => setTimeout(r, 10)); // let background refresh land
    check("background refresh fired exactly once", fetchCalls === 2);
    const after = await cache.get("42", "tekmetric");
    check("next read sees refreshed value", after.config.v === 2 && !after.stale);
  }

  // ---- cold miss deadline: stalled fetch (401 retries etc.) -------------
  {
    console.log("cold read is bounded by ONE end-to-end deadline even when fetch stalls");
    const { storageGet, storageSet } = makeStorage();
    let resolveStalled: (v: any) => void = () => {};
    const stalled = new Promise((r) => (resolveStalled = r));
    const cache = createStickerConfigCache({
      fetchConfig: () => stalled as any, // simulates retry sleeps / silent re-auth taking forever
      storageGet,
      storageSet,
      fetchDeadlineMs: 50,
      log: quietLog,
    });
    const started = Date.now();
    let threw: any = null;
    try {
      await cache.get("42", "tekmetric");
    } catch (e) {
      threw = e;
    }
    const elapsed = Date.now() - started;
    check("cold read rejected (caller falls back to defaults)", !!threw);
    check("rejection carries the deadline code", threw?.code === "STICKER_CONFIG_DEADLINE");
    check(`rejection landed within the bound (${elapsed}ms < 1000ms)`, elapsed < 1000);

    // The stalled fetch eventually lands and must still warm the cache.
    resolveStalled({ config: { late: true }, enabled: true });
    await new Promise((r) => setTimeout(r, 10));
    const warmed = await cache.get("42", "tekmetric");
    check("late-landing fetch warmed the cache", warmed.config.late === true && warmed.fromCache === true);
  }

  // ---- invalidate: next read forces a live refresh ----------------------
  {
    console.log("invalidate forces the next read to refresh live");
    let fetchCalls = 0;
    const { storageGet, storageSet } = makeStorage();
    const cache = createStickerConfigCache({
      fetchConfig: async () => {
        fetchCalls += 1;
        return { config: { v: fetchCalls }, enabled: true };
      },
      storageGet,
      storageSet,
      log: quietLog,
    });
    await cache.get("42", "tekmetric");
    await cache.invalidate("42", "tekmetric");
    const refreshed = await cache.get("42", "tekmetric"); // still inside TTL!
    check("post-invalidate read refetched despite fresh TTL", fetchCalls === 2);
    check("post-invalidate read returned the NEW value", refreshed.config.v === 2 && refreshed.fromCache === false);
    const settled = await cache.get("42", "tekmetric");
    check("invalidation cleared after successful refresh", fetchCalls === 2 && settled.fromCache === true);
  }

  // ---- invalidate + failing refresh: last-known-good fallback -----------
  {
    console.log("invalidate + failing refresh serves last-known-good, never hangs");
    let fetchCalls = 0;
    const { storageGet, storageSet } = makeStorage();
    const cache = createStickerConfigCache({
      fetchConfig: async () => {
        fetchCalls += 1;
        if (fetchCalls > 1) throw new Error("server down");
        return { config: { v: 1 }, enabled: true };
      },
      storageGet,
      storageSet,
      fetchDeadlineMs: 50,
      log: quietLog,
    });
    await cache.get("42", "tekmetric");
    await cache.invalidate("42", "tekmetric");
    const fallback = await cache.get("42", "tekmetric");
    check("failed forced refresh fell back to last-known-good", fallback.config.v === 1 && fallback.fromCache === true && fallback.stale === true);
  }

  // ---- concurrent cold reads dedupe --------------------------------------
  {
    console.log("concurrent cold reads dedupe into one fetch");
    let fetchCalls = 0;
    const { storageGet, storageSet } = makeStorage();
    const cache = createStickerConfigCache({
      fetchConfig: async () => {
        fetchCalls += 1;
        await new Promise((r) => setTimeout(r, 20));
        return { config: {}, enabled: true };
      },
      storageGet,
      storageSet,
      log: quietLog,
    });
    await Promise.all([cache.get("42", "tekmetric"), cache.get("42", "tekmetric"), cache.get("42", "tekmetric")]);
    check("three simultaneous reads -> one fetch", fetchCalls === 1);
  }

  // ---- persistence round-trip --------------------------------------------
  {
    console.log("entries persist through injected storage (MV3 worker restart)");
    const storage = makeStorage();
    const cacheA = createStickerConfigCache({
      fetchConfig: async () => ({ config: { persisted: true }, enabled: true }),
      storageGet: storage.storageGet,
      storageSet: storage.storageSet,
      log: quietLog,
    });
    await cacheA.get("42", "tekmetric");
    await new Promise((r) => setTimeout(r, 10)); // persist is fire-and-forget
    // "Restart": new cache instance, same storage, fetch now fails.
    const cacheB = createStickerConfigCache({
      fetchConfig: async () => {
        throw new Error("network down");
      },
      storageGet: storage.storageGet,
      storageSet: storage.storageSet,
      log: quietLog,
    });
    const revived = await cacheB.get("42", "tekmetric");
    check("restarted worker served the persisted entry", revived.config.persisted === true && revived.fromCache === true);
  }

  if (failures > 0) {
    console.error(`\n${failures} sticker-config-cache check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll sticker-config-cache checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
