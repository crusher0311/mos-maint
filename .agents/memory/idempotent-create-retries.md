---
name: Idempotent create retries
description: Duplicate-safe retry pattern for Protractor create routes (upsert-by-ID) and the two review-mandated constraints.
---

Protractor creates are upserts by ID (`POST /Contact|ServiceItem|WorkOrder/{id}`), which makes timed-out retries duplicate-safe — but two constraints are mandatory:

1. **Never pass a client-supplied UUID straight through as the upstream entity ID.** Any authenticated writer could target an EXISTING record's UUID and overwrite it (broken access control — completion review rejects this). Derive it server-side instead: hash(kind|shopId|userId|clientRequestId) → v4-shaped UUID (`lib/idempotent-create-id.ts`). Deterministic for retries, preimage-safe against targeting, scoped per shop+user.

2. **A route deadline (withUpstreamTimeout) does not cancel the still-running upstream operation.** For multi-step creates (WO + appended service packages), pinning only the root ID is NOT idempotent — a retry racing the still-running first attempt re-appends packages. Fix: derive package/line/concern IDs deterministically from the pinned root ID AND skip-if-already-present when re-fetching the entity before append.

**How to apply:** any interactive create with retry semantics against an upsert-by-ID upstream; mirror dashboard + extension routes. Client (sidepanel/wizard) keeps one key per pending create: generate-if-absent, reuse on retry, clear on success/entity-change/reset.
