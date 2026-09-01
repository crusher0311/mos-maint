import type { Db } from "mongodb";
import * as callbackEvents from "@/lib/data/repositories/protractor-callback-events";

export async function processProtractorCallbackQueue(
  db: Db,
  dispatch: (item: callbackEvents.PendingGetEvent) => Promise<void>,
  options: { limit?: number; maxAttempts?: number; budgetMs?: number } = {},
): Promise<{ processed: number; failed: number }> {
  const pending = await callbackEvents.findPendingGetEvents(options.limit ?? 50, options.maxAttempts ?? 3);
  let processed = 0;
  let failed = 0;
  const started = Date.now();
  for (const item of pending) {
    if (Date.now() - started > (options.budgetMs ?? 180_000)) break;
    const identity = item.objectType && item.objectId ? {
      shopId: item.shopId,
      method: item.method,
      objectType: item.objectType,
      objectId: item.objectId,
      operation: item.operation,
    } : null;
    let admitted = false;
    try {
      if (identity) {
        admitted = await callbackEvents.admitCallbackEvent(item.key, identity);
        if (!admitted) continue;
      }
      await callbackEvents.recordProcessingStarted(item.key);
      await dispatch(item);
      processed++;
    } catch (error: any) {
      await callbackEvents.recordError(item.key, error?.message || String(error));
      failed++;
    } finally {
      if (admitted && identity) {
        await callbackEvents.finishCallbackEventAdmission(item.key, identity, false);
      }
    }
  }
  return { processed, failed };
}