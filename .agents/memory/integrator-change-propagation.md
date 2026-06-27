---
name: Integrator change-propagation lag (MOS->Protractor writes)
description: Why AutoFlow/AppFueled don't see MOS-initiated Protractor changes instantly, and what's missing
---

# Downstream propagation of MOS-initiated Protractor writes

When MOS writes to Protractor (extension Create-WO / add-job), MOS knows instantly, but downstream integrators lag because none of them initiated the change:

- **AutoFlow** learns only via Protractor's own webhook chain. Observed on RO 50835 (shop 29, 2026-06-27): created 20:11:02 → Protractor callback to MOS 20:12:50 → AutoFlow webhook to MOS 20:13:06 (~2 min end-to-end).
- **AppFueled** is **pull-only** — it polls MOS's external VHI API on its own cadence; MOS does **not** push to it.
- **There is no outbound MOS->partner webhook fan-out** in the codebase. The only way to make changes propagate instantly is for MOS to emit at write time (MOS is the only system that knows immediately).

**Where to look (Mongo, db `mos-maintenance-mvp`):**
- `protractor_work_orders.createdAt` ≈ MOS write time (finalize snapshots the WO right after the write).
- `protractor_callback_events.receivedAt` = inbound Protractor webhooks to MOS.
- `events` firehose, `provider: "autoflow"` = inbound AutoFlow webhooks to MOS.

**Design fork (unresolved):** an outbound event bus only works for partners that can RECEIVE a push (expose a URL). Pull-only partners (AppFueled today) instead need a cheap incremental "changes since X" feed they can poll frequently. Which path depends on each partner's receiving capability.
