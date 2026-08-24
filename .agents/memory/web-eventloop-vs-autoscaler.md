---
name: Web event-loop saturation invisible to autoscaler
description: Render autoscaler scales on whole-instance CPU; Node pins one core, so a saturated event loop never triggers scale-up.
---
Symptom set: many unrelated crons time out, extension OEM fetches hit their 15s race, users report "unusable" slowness — while Postgres/Mongo/provider APIs are all fast and instance CPU looks low (~1 core of many).
**Why:** Node is single-threaded; autoscaler target is total instance CPU (e.g. 2400 units) so 1 pinned core (~200-300 units) never scales 1→2 instances. Fleet ran on ONE saturated instance during business hours 2026-08-24.
**How to apply:** check Render /metrics/cpu + autoscaling events first; HostLoadSampler loop p95 is the honest signal. Durable fixes: min instances 2, or scale on event-loop lag; also keep CPU-heavy cron work off the web service.
