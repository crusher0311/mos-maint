/**
 * Structured slow-call / hang observability for partner-facing routes
 * (task #1119).
 *
 * `withUpstreamTimeout` bounds a call AND changes behavior (returns a
 * fallback). This helper is the observability-only sibling: it NEVER
 * changes the result, rejection, or timing of the wrapped promise — it
 * just guarantees a hang leaves evidence in Better Stack:
 *
 *   - When the call is still pending after `slowMs`, it emits ONE
 *     structured warn line (`slow_call_pending`) — so a true hang always
 *     logs even if the request never completes.
 *   - When the call settles after having crossed `slowMs`, it emits a
 *     completion line (`slow_call_finished` / `slow_call_failed`) with the
 *     total duration.
 *
 * Lines are single-line and grep-stable:
 *   [SlowCall] slow_call_pending label=<label> pendingMs=<n> <extra>
 */
export async function withSlowCallLog<T>(
  promise: Promise<T>,
  label: string,
  slowMs: number,
  extra?: string,
): Promise<T> {
  let crossed = false;
  const started = Date.now();
  const suffix = extra ? ` ${extra}` : "";
  const timer = setTimeout(() => {
    crossed = true;
    console.warn(
      `[SlowCall] slow_call_pending label=${label} pendingMs=${slowMs}${suffix} — still waiting on upstream`,
    );
  }, slowMs);
  try {
    const result = await promise;
    if (crossed) {
      console.warn(
        `[SlowCall] slow_call_finished label=${label} durationMs=${Date.now() - started}${suffix}`,
      );
    }
    return result;
  } catch (err: any) {
    if (crossed) {
      console.warn(
        `[SlowCall] slow_call_failed label=${label} durationMs=${Date.now() - started}${suffix} error=${String(err?.message || err).slice(0, 200)}`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
