# Callback local-work pipeline

This release does **not** enable production concurrency.

`PROTRACTOR_CALLBACK_PIPELINE_WIDTH` accepts exactly `1`, `2`, `3`, or `4`.
Unset, malformed, or out-of-range values use `1` (serial). Only the dedicated
callback worker reads this setting; web/cron drains stay serial.

Start a separately approved production trial at **2**, not 4. Additional local
overlap is not additional provider capacity. The fleet physical-transport mutex,
callback transport lease, cooldown, retry policy, admission budget, replay floor,
and emergency stop are unchanged.

The pipeline overlaps different shops only. It preserves order within each shop
and holds that shop's local slot through completion and admission release. This
avoids concurrent WorkOrder/ServiceItem updates to a shop's vehicle without
assuming callback object IDs are vehicle IDs. This is local worker protection,
not a new distributed vehicle lock: keep the dedicated worker at one instance.
Existing durable object ownership remains required across all replicas.

Selection, terminal authority and the recovery slot are unchanged. A blocked
shop can be skipped temporarily to use another free slot, but its next item
cannot overtake its own in-flight item. The selected batch still caps admissions
at 45. Stop/deadline/budget exhaustion prevents new scheduling; already-admitted
work is awaited. Unexpected repository errors stop new scheduling and propagate
only after all in-flight work settles.

## Trial requirements (not executed by this change)

1. Deploy the tested candidate with the setting absent/`1`; verify the running
   worker commit and keep a single worker instance.
2. With operator approval, enable `2` on the dedicated worker only and deploy
   that configuration. A saved Render setting is not proof of runtime adoption.
3. Compare equal windows for active completions (separate from duplicate
   closures), pending unique objects, oldest/median/p95 age, local stage times,
   provider errors, interactive latency, and database load.
4. Stop the trial on sustained provider errors, increasing interactive latency,
   database pressure, overlapping same-shop writes, or failed shutdown draining.
   Restore width `1` through a deployment. Existing operator stop remains the
   emergency protection; do not remove it to speed rollback.
5. Consider 3 or 4 only if 2 improves freshness without increasing error/load.
   Do not infer gains from raw notification closures alone.

## Offline checks

- `node --import tsx tests/protractor-callback-pipeline.smoke.ts`
- `node --import tsx tests/protractor-callback-queue-runtime.smoke.ts`
- `node --import tsx tests/protractor-callback-worker.smoke.ts`
- `node --import tsx tests/protractor-fleet-pacer.smoke.ts`

Use the project's credential-free offline environment; never boot a local worker
against the shared production stores to test this feature.
