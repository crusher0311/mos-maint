# Telle store 101 diagnostic — not activated

MOS shop 282 only; report interval January 1–November 8, 2026 inclusive,
America/Chicago. This is a read-only invoice comparison, not import or delivery.

The approved 233 references produce 269 exact candidate GET endpoints (known
invoice GUIDs and at most three 100-row pages on dates for unknown GUIDs).
Their sorted Merkle root is pinned in the policy. Proofs do not authorize new
shops, arbitrary dates, work-order endpoints, extra pagination or writes.
Unrelated rows returned by date lookup are discarded in memory.

## Separate production prerequisites

No prerequisites are installed by these changes. A reviewed release must include
the policy, shared transport/accounting changes and diagnostic script together.
An operator must separately approve a maximum 30-minute execution window and
install `telleRecovery` on the existing physical-transport control record:
version 6, shopId 282, from `2026-01-01`, until `2026-11-09`, pinned manifestRoot,
fresh runId, current canaryGeneration, current shop connection bindingDigest,
Date notBefore/expiresAt, integer maxRequests (1–500), consumedRequests 0 and
stopped false. This is new recovery authorization bookkeeping, not permission
to modify source invoices. Never replace the whole control record.

Only then enable `PROTRACTOR_TELLE_RECOVERY_ENABLED=true` for the isolated
diagnostic process and run the script with `--scoped-recovery`. Do not enable
the ordinary production job launcher: its legacy mode deliberately lacks this
grant. Supply the approved metadata-only missing-investigation input privately.
No credentials or full customer payloads belong in that input or logs.

Each request reloads the grant, verifies the connection binding, and enters a
separate shop-history context. The physical transport atomically rechecks
revocation, expiry, generation and the independent request budget. Existing
operator stop, relay-only production transport, shared pacing and leases remain.
No callback or interactive identity is fabricated. Failed/ambiguous admissions
are not refunded. No retry or upstream writes, cache repair or Azure delivery.

Revoke by setting only `telleRecovery.stopped=true`; remove process enablement
after the run. An already admitted request may finish. Preserve counters for
audit. A successful comparison is not full-history or downstream-persistence
proof. A nonmatching/failed lookup stays unresolved; it is not silently skipped.
