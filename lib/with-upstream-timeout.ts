/**
 * Race a promise against a wall-clock timeout. On timeout, resolves with
 * `fallback` (instead of throwing) so the caller can keep going with cached
 * or partial data — critical for user-facing endpoints whose upstream
 * dependencies (Tekmetric, CARFAX) can stall for tens of seconds on busy
 * shop days. Logs a single warn line so we can spot timeouts in BetterStack.
 *
 * Designed for the extension VHI panel routes
 * (`/api/extension/plan`, `/api/extension/ro-context`) where a 30s+
 * upstream hang was making the whole panel feel broken at customer sites.
 *
 * The returned promise NEVER rejects — exceptions from the wrapped promise
 * are swallowed (logged and `fallback` returned) so a single failing
 * upstream cannot blow up the whole request.
 */
export async function withUpstreamTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  fallback: T,
  // Task #737: optional hook fired when the budget is exhausted (timeout
  // only, not upstream throw) so callers can record WHICH budget was
  // exhausted for slow-load observability without parsing log lines.
  opts?: { onTimeout?: () => void },
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutSentinel = Symbol("upstream-timeout");
  try {
    const result = (await Promise.race([
      promise.then((v) => v as unknown),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(timeoutSentinel), timeoutMs);
      }),
    ])) as T | typeof timeoutSentinel;
    if (result === timeoutSentinel) {
      console.warn(
        `[upstream-timeout] ${label} exceeded ${timeoutMs}ms — returning fallback`,
      );
      try {
        opts?.onTimeout?.();
      } catch {}
      return fallback;
    }
    return result;
  } catch (e: any) {
    console.warn(
      `[upstream-timeout] ${label} threw before timeout: ${e?.message || e}`,
    );
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
