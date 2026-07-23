---
name: Protractor retry/concurrency-limiter deadlock
description: Why recursive retries inside a p-limit slot deadlock the whole Protractor client under simultaneous 500s/429s
---

The Protractor client's 500/429 retry used to recursively call `protractorFetch`,
which re-enters the shared `pLimit(3)` concurrency pool while the failing call
still HOLDS its slot. When all in-flight requests hit retryable errors at the
same time (easy during business-hours upstream saturation — nginx 500s come in
bursts), every slot-holder waits for a slot that can never free: the whole
client freezes silently, forever. The log signature is N simultaneous
"Server error 500, retrying in ..." lines followed by total silence while the
process stays alive.

**Why:** p-limit slots are not re-entrant; a retry is a continuation of the
same logical request, not a new one.

**How to apply:** retries in any limiter-wrapped fetch must be a loop inside
the held slot (re-acquiring only the rate-limit slot per attempt), never a
recursive re-entry into the limiter. Check other clients (Tekmetric, Shop-Ware)
for the same recursive-retry-inside-limiter shape before trusting their
long-running bulk jobs.

Regression guard exists: tests/protractor-retry-limiter-deadlock.smoke.ts
(in the prebuild smoke chain) simulates > pool-size simultaneous 500s via
`__protractorClientTestHooks` (httpsRequest / distributed-slot / trackApiRequest
overrides + `retryBaseDelayMs`) and fails fast on hang via hard timeouts.
Keep the hooks indirection when refactoring the client.
