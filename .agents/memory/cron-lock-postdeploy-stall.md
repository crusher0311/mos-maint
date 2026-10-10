---
name: Post-deploy cron lock stall
description: Retained cron leases after restarts or ambiguous transport failures are not proof of a stuck scheduler.
---

# Post-deploy cron lock stall (expected, self-healing)

After a restart or ambiguous HTTP failure, repeated cron skips without a new
winning run can be expected until the prior job's effective lease expires.
Do not assume all jobs recover within ten minutes.

**Why:** A killed process cannot release its lease, and an HTTP disconnect does
not establish that its server-side work stopped. Treating either as completion
can create duplicate work. Long-request jobs require longer exclusion windows.

**How to apply:** Diagnose skips against the particular job's effective lease,
not a fixed ten-minute threshold. Do not hand-clear leases to accelerate recovery.
Old replicas must drain before claiming fleet-wide protection; mixed-version
deployment cannot fix the admission/release behavior of binaries still running.
