/** Serial durable batches: no detached work, no additional provider concurrency. */
export async function runCallbackWorkerLoop(deps: {
  stopping: () => boolean;
  drain: () => Promise<{ processed: number; failed: number }>;
  sleep: (ms: number) => Promise<void>;
  report: (result: { processed: number; failed: number } | null) => void;
}): Promise<void> {
  let failures = 0;
  while (!deps.stopping()) {
    let delay = 1_000;
    try {
      const result = await deps.drain();
      failures = 0;
      deps.report(result);
      if (result.processed === 0) delay = 10_000;
    } catch {
      failures++;
      delay = Math.min(60_000, 5_000 * 2 ** Math.min(failures - 1, 4));
      deps.report(null);
    }
    // Short waits let shutdown stop promptly even while idle/backing off.
    for (let remaining = delay; remaining > 0 && !deps.stopping(); remaining -= 250) {
      await deps.sleep(Math.min(250, remaining));
    }
  }
}
