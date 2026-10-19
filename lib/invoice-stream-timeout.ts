/** Transaction-local cache only. Keep server execution capped at five seconds,
 * shortening near the absolute request deadline. Never renew the deadline or
 * bypass the caller's active-query cancellation. Failed SETs are not cached. */
export function invoiceStreamTimeout(set: (ms: number) => Promise<void>, capMs = 5000) {
  let last: number | undefined;
  return async (remaining: number) => {
    const ms = Math.max(1, Math.min(capMs, 5000, Math.floor(remaining / 1000) * 1000));
    if (last !== ms) {
      await set(ms);
      last = ms;
    }
  };
}
