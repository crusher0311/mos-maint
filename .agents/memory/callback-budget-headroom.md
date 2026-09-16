---
name: Callback budget headroom
description: Keep completion time separate from callback admission time when tuning throughput.
---

Callback admission budgets must leave room for already-admitted work to finish
before the scheduler times out. Provider request headroom alone is insufficient.

**Why:** A proposed 45-second trial left only five seconds under the scheduler
timeout, while observed callback processing p95 was about 7.6 seconds. The user
approved a smaller increase instead. Admission deadlines do not abort durable
completion, so the remaining margin is not a guaranteed completion bound.

**How to apply:** Compare live callback-duration distributions against the
scheduler timeout and lease before extending budgets. Keep pacing, concurrency,
retry limits, and held-history restrictions unchanged during isolated budget
trials. Evaluate timeout/overlap and interactive latency alongside throughput.