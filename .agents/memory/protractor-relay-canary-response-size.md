---
name: Relay canary response-size stop
description: Why the first fleet-wide relay hard-cap canary was stopped despite clean pacing and no upstream 429 or 5xx responses.
---

The first full organic canary through relay contract version 2 maintained the required pacing: 234 completed requests, 231 HTTP 200, three HTTP 401, no 429, no upstream 5xx, and no sub-second completion-to-next-start gaps. The minimum observed completion-to-next-start gap was 1.358 seconds.

Three REST GET responses exceeded the relay's 5 MB response-body cap and produced relay-generated `upstream_response_too_large` 502 rejections. Treat this as a stop condition until the calls are safely attributed and the expected maximum response size is understood.

**Why:** Raising the cap blindly could turn large provider responses into a relay memory-exhaustion path. Leaving the fleet open would also keep failing those production reads. The existing relay request event omits shop and endpoint class, while the response event is never emitted for relay transport rejection, so current logs cannot attribute these failures.

**How to apply:** Keep production outbound disabled and both workers suspended. Before another canary, add privacy-safe attribution that survives relay-generated failures, determine which REST operation and shop class crosses 5 MB, then set a justified bounded cap or reduce/page the upstream request. Preserve the one-second authoritative relay pacing.