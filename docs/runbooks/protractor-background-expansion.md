# Controlled Protractor background expansion

## Status and authorization

Prepared for operator review on 2026-10-13. This document does not activate
background traffic, change production configuration, or authorize a deployment.
No new grant has been installed.

The operator approved preparation of a controlled expansion, not removal of
permanent transport protections or an unrestricted fleet restart.

## Existing operating boundary

- Leave the continuous `callbacks_and_interactive` generation running.
- Preserve relay-only dispatch, shared physical pacing and concurrency controls,
  circuit breakers, the operator emergency stop, and development egress denial.
- Do not disable `PROTRACTOR_CALLBACK_TRIAL_ENABLED` as a shortcut.
- Do not change the callback replay floor or admit older callback backlog.
- Keep general background workers suspended; verify their live service state,
  rather than relying only on the persisted suspension attestation.
- Keep JWT financial recovery independent. An invoice history pilot does not
  authorize financial corrections or renewal of a JWT permission.

Read-only preflight found Burnett shop 538's original history import marked
completed for all 427 daily windows. Its stopped permission used 427 of its
1,000 allowed requests and expired October 9. The old JWT permission is also
stopped and expired. Do not reset either record or repeat the completed import.

## First pilot proposal

| Boundary | Proposed value |
| --- | --- |
| Shop | One operator-selected Protractor shop with a verified history gap |
| Data scope | One explicit, incomplete historical invoice date window |
| Provider operations | Final-invoice list GETs only, including bounded pagination |
| Budget | At most 100 physical attempts, including retries |
| Duration | At most 15 minutes, ending sooner at the shop's quiet-window cutoff |
| Parallelism | One dedicated runner, one page and one local normalization operation at a time |
| General workers | Remain suspended |
| Renewal | None automatically |
| Provider writes / detail fan-out | Not permitted |

These are proposed operating limits, not claims that a generic pilot runner
already enforces them.

## Required implementation before activation

The existing shop-history policy and runner are deliberately fixed to shop 538,
its connection binding, date range, and October 8–9 approval. Do not extend those
constants or repurpose its archived grant.

A fresh implementation must provide:

1. A stopped-by-default, one-use grant bound to one shop, its validated provider
   connection, an explicit date range, the active live generation, a fresh run ID,
   and a reviewed manifest digest.
2. Server-clock start and expiry checks and a request budget consumed atomically
   at the existing physical-dispatch confirmation boundary. No preliminary
   counter, refund after ambiguous confirmation, or fallback to interactive,
   callback, JWT, legacy, or direct-transport authority.
3. A single-owner resumable runner. Pin page source evidence and save per-record
   completion receipts before advancing the cursor. Lost acknowledgments must
   not trigger blind replay of completed local writes.
4. Quiet-hour enforcement on each page/admission, bounded provider and local
   database deadlines, serial normalization, and an explicit partial/unresolved
   result. Thin invoice rows remain unresolved; do not fetch details implicitly.
5. A separate pilot stop that closes its admission without stopping normal
   callbacks. The existing global stop must still override every channel.
6. A report separating physical admissions, completed responses, no-response
   transport failures, local denials, normalization outcomes, and unresolved work.
7. Offline tests for wrong shop/connection/generation, expired/stopped grants,
   budget exhaustion, concurrent runners, ambiguous confirmation, lost write
   acknowledgments, cutoff during a page, and emergency-stop races.

## Activation checklist

- Confirm the selected shop, exact gap, provider connection, and quiet hours.
- Verify the gap against existing receipts; do not infer a gap from an old cursor.
- Confirm no conflicting runner owns this work.
- Verify suspended general workers and the unchanged transport safety settings.
- Capture a fresh production baseline. Request duration includes local admission
  waiting; it is not a measurement of provider latency alone.
- Verify that transport-error telemetry is current and readable for the pilot
  window. Missing log windows are not zero errors.
- Review and deploy the tested implementation separately.
- Obtain explicit approval for the named shop, date scope, budget, and execution
  window; install a fresh stopped grant, then activate that exact one-use run.

## Pause and rollback

Pause the pilot on its first provider 429, transport timeout, authentication
failure, unresolved admission/write outcome, loss of checkpoint ownership, or
loss of monitoring coverage. A provider 5xx also requires review before more
pilot work. Preserve evidence and consumed budget; do not automatically restart.

Pause if current callback/staff health materially worsens: compare the same
duration metric with the immediate baseline, including queue waits, and review
timeouts and callback progress rather than a latency percentile alone.

Stop the pilot immediately at its deadline or budget limit. An operator may use
the global emergency stop for a fleet incident, but ordinary pilot shutdown must
not disable customer-facing traffic.

Before any restart, verify that the predecessor has terminated and reconcile its
receipts and admissions. Require fresh explicit authorization; never renew an
expired grant or erase its history.

## Expansion decision

Completing the pilot does not automatically open another shop, renew its budget,
or start workers. Review complete telemetry and durable progress first. A clean
pilot supports a separately approved longer single-shop run; a clean sustained
run supports gradual shop-by-shop expansion under the unchanged shared limiter.
Historical callback replay and broad worker resumption remain separate decisions.
