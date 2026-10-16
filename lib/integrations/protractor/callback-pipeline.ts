/**
 * Local overlap only: callers retain every durable claim and transport guard.
 * One item per shop avoids concurrent WO/ServiceItem updates to the same vehicle.
 */
export function callbackPipelineWidth(value: unknown): number {
  return typeof value === "string" && /^[1-4]$/.test(value) ? Number(value) : 1;
}

export async function runCallbackPipeline<T>(
  items: readonly T[],
  width: number,
  shopKey: (item: T) => string,
  shouldStop: () => boolean,
  work: (item: T) => Promise<boolean>,
): Promise<void> {
  const capacity = Number.isInteger(width) && width >= 1 && width <= 4 ? width : 1;
  const waiting = [...items];
  const busy = new Set<string>();
  const active = new Set<Promise<void>>();
  let stopped = false;
  let failed = false;
  let error: unknown;
  try {
    while (waiting.length || active.size) {
      while (!stopped && !shouldStop() && active.size < capacity) {
        const index = waiting.findIndex(item => !busy.has(shopKey(item)));
        if (index < 0) break;
        const [item] = waiting.splice(index, 1);
        const key = shopKey(item);
        busy.add(key);
        const task = Promise.resolve().then(() => work(item)).then(keepGoing => {
          if (!keepGoing) stopped = true;
        }).catch(cause => {
          if (!failed) error = cause;
          failed = true;
          stopped = true;
        }).finally(() => {
          busy.delete(key);
          active.delete(task);
        });
        active.add(task);
      }
      if (!active.size) break;
      await Promise.race(active);
    }
  } finally {
    // Never report a batch finished while another admitted item is still saving.
    await Promise.all(active);
  }
  if (failed) throw error;
}
