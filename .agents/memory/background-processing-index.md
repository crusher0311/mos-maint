---
name: Background processing constraints
description: Index of capacity, scheduling and queue lessons for background imports.
---

- [Background lane starvation](background-lane-starvation.md)
- [Backfill worker saturation](backfill-worker-mongo-saturation.md)
- [Worker power schedule](worker-power-schedule.md)
- [BullMQ backfill queue](bullmq-backfill-queue.md)
- [Tekmetric queue lane timeouts](tekmetric-queue-lane-timeouts.md)
- [Tekmetric capacity lanes](tekmetric-capacity-lanes.md)
- [Tekmetric throughput ceilings](tekmetric-throughput-ceilings.md)
- [Backfill horizon](backfill-horizon.md)
- [Fleet stall detection](pipeline-stall-detection.md)
- [Event-loop saturation](web-eventloop-vs-autoscaler.md)
- [Tekmetric drain wedge](tekmetric-drain-wedge.md) — hung upstream calls can retain the global lease.
- [Protractor chunk cost](protractor-normalize-chunk-cost.md) — dense chunks can be dominated by serial normalization.
- [Post-deploy lease stalls](cron-lock-postdeploy-stall.md) — retained leases must not be hand-cleared.
- [Tekmetric full-page completion](tekmetric-fullpage-completion.md) — final indexing can block completion and queue handoff.
- [Smart backfill timing](smart-backfill-timing.md) — off-hours enforcement and fallback windows require approval.
- [Protractor history administration](protractor-history-administration.md) — routine controls belong in MOS; shop-635 scope is not activation approval.
