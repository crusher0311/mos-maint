// Tiny deterministic IndexedDB API fixture for hook tests. This is not a
// production storage implementation or a substitute for real-browser coverage.
export function offlineRODatabase() {
  const records = new Map<string, unknown>();
  const keyOf = (key: unknown) => JSON.stringify(key);
  const database = {
    close() {},
    createObjectStore() {},
    transaction() {
      let pending = 0;
      let aborted = false;
      const tx = {
        oncomplete: null as null | (() => void),
        onerror: null as null | (() => void),
        onabort: null as null | (() => void),
        abort() { aborted = true; tx.onabort?.(); },
        objectStore() {
          function request(action: () => unknown) {
            pending++;
            const req = { result: undefined as unknown, onsuccess: null as null | (() => void) };
            setTimeout(() => {
              if (aborted) return;
              req.result = action();
              req.onsuccess?.();
              pending--;
              if (!pending) queueMicrotask(() => { if (!pending && !aborted) tx.oncomplete?.(); });
            }, 0);
            return req;
          }
          return {
            get(key: unknown) { return request(() => records.get(keyOf(key))); },
            getAll() { return request(() => [...records.values()]); },
            count() { return request(() => records.size); },
            put(value: { shopId: number; actorKey: string }) { return request(() => { records.set(keyOf([value.shopId, value.actorKey]), value); }); },
            delete(key: unknown) { return request(() => records.delete(keyOf(key))); },
          };
        },
      };
      return tx;
    },
  };
  return {
    records,
    indexedDB: {
      open() {
        const request = { result: database, onupgradeneeded: null, onblocked: null, onerror: null, onsuccess: null as null | (() => void) };
        setTimeout(() => request.onsuccess?.(), 0);
        return request;
      },
    },
  };
}
