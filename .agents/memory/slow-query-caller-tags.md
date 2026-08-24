---
name: Slow-query caller tags
description: How slow-query caller attribution works and its security invariant
---
Caller attribution (lib/slow-query/caller-context.ts): src/instrumentation.ts patches http.Server.prototype.emit so every request (incl. cron's internal /api/cron/* HTTP invocations) runs in an ALS context; the tracker reads the tag at capture time (Mongo: at commandStarted, since completion events lose ALS context; PG: at first .then).
**Why:** a code review rejected persisting raw path segments — routes like /api/join/[code] and /api/webhooks/*/[token] embed secrets, and heuristic redaction (length/charclass) leaks short codes.
**How to apply:** tags must be built ONLY from app/ route templates (:param placeholders); unmatched paths → "/…". Non-HTTP entry points use runWithSlowQueryCaller(). Worker/BullMQ loops still untagged.
