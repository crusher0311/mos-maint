---
name: Cache/identity cutover gating coverage
description: Which repos are flag-gated for the PG cutovers and where the purity gaps remain
---
All five integration caches now have flag-gated abstracted repos + PG repos (tekmetric-work-orders → pg/tekmetric-cache; autoflow-cache → pg/autoflow-cache; plus pre-existing protractor/shopware/autovitals). Identity abstracted repos (sessions/shops/users under lib/data/repositories) gate on IDENTITY_PG_CANONICAL onto pg/identity.
**Why:** flag flips are only "pure" for callers routed through these repos; the sync/backfill WRITERS and heavy aggregate readers (dashboard data, plan-build, vhi-rebuild) still hit Mongo directly — safe only while WRITE_MONGO_* shadow is ON.
**How to apply:** before any shadow-off, fold remaining direct call sites (inventory in docs/runbooks/db-integration-cache-cutover.md) and gate with `tsx scripts/cutover-parity.ts --domain=<d>` (read-only; non-zero exit = no-go). Untranslatable Mongo query shapes (nested-jsonb $or/$exists lookups) are left Mongo-only with loud in-file comments.
