import { getDb } from "@/lib/mongo";
import { insertWebhookLog as insertTekmetricWebhookLog } from "@/lib/data/repositories/tekmetric-ops";

/**
 * Test seam for the Tekmetric webhook route (extracted from route.ts because
 * Next's generated route types reject non-handler exports from route files —
 * tsc against .next/types fails on any extra export).
 *
 * Tests override `__deps.getDb` to swap in a fake DB and `__deps.defer` to
 * intercept the fire-and-forget background work the route dispatches after
 * writing the inline cache row.
 *
 * `defer` is what implements step 3 of TEKMETRIC_5K_SCALING_PLAN.md (task #376):
 * heavy NIS dual-writes and `getVehicle`/`getCustomer` enrichment fetches are
 * pushed off the request thread so the webhook returns in <500ms while the
 * cache + indexer + plan-invalidate work that drives dashboard freshness still
 * runs inline. Errors are logged but never affect the 200 OK back to Tekmetric
 * (preserves the soft-fail contract Tekmetric depends on for retries).
 *
 * Production callers go through the real implementations unchanged. The
 * latency smoke test (tests/tekmetric-webhook-latency.smoke.ts) overrides
 * `defer` to capture promises so it can both measure the inline budget and
 * assert the deferred work eventually completed.
 */
export type DeferFn = (fn: () => Promise<void>) => void;
const defaultDefer: DeferFn = (fn) => {
  // Use setImmediate so the deferred work runs after the current
  // request/response cycle has yielded — the handler can return its 200 OK
  // first, then the NIS dual-write / enrichment kick off. Any thrown errors
  // are logged but never surface to Tekmetric.
  setImmediate(() => {
    fn().catch((err: any) => {
      console.error(
        "[Tekmetric Webhook] Deferred work failed:",
        err?.message || err,
      );
    });
  });
};
export const __deps: {
  getDb: typeof getDb;
  defer: DeferFn;
  insertWebhookLog: typeof insertTekmetricWebhookLog;
} = {
  getDb,
  defer: defaultDefer,
  // Webhook-log writes go through the flag-gated Mongo/PG repository;
  // exposed here so smoke tests can capture them alongside the fake db.
  insertWebhookLog: insertTekmetricWebhookLog,
};
