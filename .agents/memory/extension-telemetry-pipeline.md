---
name: Extension telemetry pipeline
description: Two-sided event allowlist, slow-call floor, and per-signature throttle contract for extension telemetry
---
Rule: any new extension telemetry event name must be added on BOTH sides — the extension emitter and the server route's allowlist — because the server silently drops unknown names.

**Why:** the route is fire-and-forget by design; a one-sided change loses data with zero errors surfaced anywhere.

**How to apply:**
- Ship server first (allowlist), extension second (manual CWS publish; manifest version bump in the same commit — a prebuild gate enforces it).
- Slow-call floor is server-env-tunable, so it can be raised/lowered without an extension release; clients with a lower threshold just get events dropped.
- Flood control is client-side per-signature throttling with suppressed occurrences folded into the next event's `count`; any consumer (rollups, dashboards, alerts) must sum `count` (default 1), not documents, or bursts are massively underreported.
- Content-script error hooks share the page window — only report errors sourced from extension-origin files, or page errors leak in.
- Thrown fetch failures (network/timeout/mid-retry) need explicit try/finally-style capture; response-path emits alone miss exactly the failures worth seeing.
- Per-shop correctness: shop context is mutable (SPA tab switches, persistent side panel), so throttle buckets must be shop-scoped everywhere suppression happens, request-derived events must pin attribution from a request-START snapshot (never re-read the global at emit/flush time), and server rate limiting must bucket per distinct shop in a batch — otherwise one shop's suppressed counts/budget bleed into another shop's numbers.
