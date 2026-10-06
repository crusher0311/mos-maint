---
name: Relay canary response-size stop
description: Why the first fleet-wide relay hard-cap canary was stopped despite clean pacing and no upstream 429 or 5xx responses.
---

The first full organic canary through relay contract version 2 maintained the required pacing: 234 completed requests, 231 HTTP 200, three HTTP 401, no 429, no upstream 5xx, and no sub-second completion-to-next-start gaps. The minimum observed completion-to-next-start gap was 1.358 seconds.

Three REST GET responses exceeded the relay's 5 MB response-body cap and produced relay-generated `upstream_response_too_large` 502 rejections. Treat this as a stop condition until the calls are safely attributed and the expected maximum response size is understood.

**Why:** Raising the cap blindly could turn large provider responses into a relay memory-exhaustion path. Leaving the fleet open would also keep failing those production reads. The existing relay request event omits shop and endpoint class, while the response event is never emitted for relay transport rejection, so current logs cannot attribute these failures.

**How to apply:** Keep production outbound disabled and both workers suspended. Before another canary, add privacy-safe attribution that survives relay-generated failures, determine which REST operation and shop class crosses 5 MB, then set a justified bounded cap or reduce/page the upstream request. Preserve the one-second authoritative relay pacing.

Task working copies can predate the shared relay-only client and preview
isolation policy. An older direct client plus absent local stop flags does
not establish authorization to send Protractor requests.

**Why:** A read-only recovery investigation encountered an older direct client
while the shared branch already required explicit preview approval and relay
transport. Using the old client would bypass the newer safety boundary.

**How to apply:** Verify the current approved transport before provider probes.
Use an approved relay-enabled runner; never use old direct dispatch as a
fallback or equate generic read-only permission with opening outbound gates.

For operator read-only investigations, the user explicitly wants the existing
relay and HMAC connection used without adding development configuration.
Check the already-configured production execution path before proposing preview
environment setup.

**Why:** A development-only denial was incorrectly presented as a blocker to
using the existing production connection. Render supports one-off jobs that
inherit a service's deployed code and configured environment.

**How to apply:** Prefer an existing approved runtime. A one-off job still
must honor its effective instance policy, outbound stops, and admission gates;
inheritance alone does not prove that a new job is authorized.

A broad `allowed: true` policy result can still carry `callbackOnly` or
`requireTimedTrial`. Check the scope restrictions, not just `allowed`, before
calling an inherited production connection.

**Why:** An existing-runtime JWT read-only preview passed the broad preflight
but correctly stopped on controlled-trial scope before sending any request.

**How to apply:** Report restricted operation scope separately from missing
relay configuration. Never fabricate callback/interactive context to admit an
operator recovery request.