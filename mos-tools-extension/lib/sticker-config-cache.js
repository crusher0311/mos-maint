// Sticker-config stale-while-revalidate cache (task #1076).
//
// The right-click interval dropdown used to block on a fresh
// GET /api/extension/sticker every time (~5s at slow shops, 45s worst case).
// The config only changes when a shop edits sticker settings, so we cache it
// per shop+provider, persist it so it survives MV3 worker restarts, and bound
// every user-facing read with ONE end-to-end deadline — covering auth retries,
// backoff sleeps, and silent re-auth inside the underlying fetch — so a cold
// miss can never hang the dropdown; callers degrade to built-in defaults.
//
// Semantics:
//  - fresh hit   -> served instantly, no network.
//  - stale hit   -> served instantly, refreshed in the background.
//  - invalidated -> next read FORCES a live refresh (bounded by the deadline);
//                   last-known-good is served only if that refresh fails.
//  - cold miss   -> live fetch bounded by the deadline; throws on failure so
//                   the caller falls back to defaults. The underlying fetch
//                   keeps running and still warms the cache when it lands.
//
// Pure module: all IO (fetch + storage) is injected so it is unit-testable
// outside the extension runtime.

export function createStickerConfigCache({
  fetchConfig, // async (shopId, provider) => ({ config, enabled })
  storageGet, // async (key) => value | undefined
  storageSet, // async (key, value) => void
  now = () => Date.now(),
  freshTtlMs = 10 * 60 * 1000,
  fetchDeadlineMs = 8000,
  storageKey = 'mosStickerConfigCache',
  log = console,
}) {
  const cache = new Map(); // key -> { config, enabled, fetchedAt, invalidated? }
  const inflight = new Map(); // key -> Promise<entry>
  let loadPromise = null;

  const keyOf = (shopId, provider) => `${shopId}:${provider || 'tekmetric'}`;

  function load() {
    if (!loadPromise) {
      loadPromise = (async () => {
        try {
          const stored = await storageGet(storageKey);
          if (stored && typeof stored === 'object') {
            for (const [k, v] of Object.entries(stored)) {
              // In-memory entries (fresher) win over persisted ones.
              if (!cache.has(k) && v && typeof v === 'object') cache.set(k, v);
            }
          }
        } catch (e) {
          // Best-effort: an unreadable store just means a cold cache.
        }
      })();
    }
    return loadPromise;
  }

  function persist() {
    const obj = {};
    for (const [k, v] of cache.entries()) obj[k] = v;
    Promise.resolve()
      .then(() => storageSet(storageKey, obj))
      .catch(() => {}); // best-effort; in-memory copy still serves this session
  }

  function fetchEntry(shopId, provider) {
    const k = keyOf(shopId, provider);
    const existing = inflight.get(k);
    if (existing) return existing;
    const p = (async () => {
      const result = await fetchConfig(shopId, provider);
      const entry = {
        config: (result && result.config) || null,
        enabled: !!(result && result.enabled === true),
        fetchedAt: now(),
      };
      cache.set(k, entry);
      persist();
      return entry;
    })();
    inflight.set(k, p);
    p.finally(() => inflight.delete(k)).catch(() => {});
    return p;
  }

  // ONE wall-clock deadline for a user-facing read. The underlying fetch is
  // NOT cancelled — if it eventually lands it still warms the cache — but the
  // caller is released within the bound either way.
  function withDeadline(promise) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`Sticker config fetch exceeded ${fetchDeadlineMs}ms deadline`);
        err.code = 'STICKER_CONFIG_DEADLINE';
        reject(err);
      }, fetchDeadlineMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  return {
    // Returns { config, enabled, fetchedAt, fromCache, stale? }. Throws only
    // when there is no cached copy at all AND the bounded fetch failed.
    async get(shopId, provider, { forceRefresh = false } = {}) {
      await load();
      const k = keyOf(shopId, provider);
      const cached = cache.get(k);
      const mustRefresh = forceRefresh || (cached && cached.invalidated === true);

      if (cached && !mustRefresh) {
        const age = now() - (cached.fetchedAt || 0);
        if (age < freshTtlMs) return { ...cached, fromCache: true };
        // Stale: serve last-known-good instantly, refresh behind the scenes.
        fetchEntry(shopId, provider).catch((err) => {
          log.warn('[MOS] Sticker config background refresh failed:', err.message);
        });
        return { ...cached, fromCache: true, stale: true };
      }

      if (cached && mustRefresh) {
        // Post-customize / forced: the next read must show edited intervals,
        // so refresh live (bounded); last-known-good only on failure.
        try {
          const entry = await withDeadline(fetchEntry(shopId, provider));
          return { ...entry, fromCache: false };
        } catch (err) {
          log.warn('[MOS] Sticker config forced refresh failed, serving last-known-good:', err.message);
          return { ...cached, fromCache: true, stale: true };
        }
      }

      // Cold miss: bounded live fetch; caller falls back to defaults on throw.
      const entry = await withDeadline(fetchEntry(shopId, provider));
      return { ...entry, fromCache: false };
    },

    // Mark entries so the NEXT read forces a live refresh (the entry is kept
    // as a failure fallback only). Called when the user enters the Customize
    // flow — settings may change server-side right after.
    async invalidate(shopId, provider) {
      await load();
      if (shopId) {
        const entry = cache.get(keyOf(shopId, provider));
        if (entry) entry.invalidated = true;
      } else {
        for (const entry of cache.values()) entry.invalidated = true;
      }
      persist();
    },
  };
}
