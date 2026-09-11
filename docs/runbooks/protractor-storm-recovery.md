# Protractor timed live-trial and storm-recovery runbook

Use this runbook only for an approved, coordinated **production** maintenance
window. The platform-admin page is an operator control, not a load-test
surface. The safe state is an active Mongo operator stop, both Protractor
workers suspended, historical backfill stopped, and Protractor outbound
traffic disabled.

The implementation does not perform Render, Mongo, worker, or provider
operations. An operator must perform the deployment and attestations described
here.

## Non-negotiable safety rules

- The Mongo operator stop is the physical-admission gate. Keep it active while
  the trial configuration is staged and deployed.
- A timed trial is exactly 30 minutes, beginning when Mongo records activation.
  It has no operator-selected expiry and no request cap. “No request cap” does
  **not** mean unguarded: the production fleet pacer, connection breakers,
  provider breaker, retry limits, and transport protections remain in force.
- An expired generation is terminal. Never reopen, extend, or clear an expired
  generation; activate a fresh stop and start a fresh generation instead.
- Workers and historical backfill stay off for the entire trial. Worker
  readiness is a manual operator attestation; the UI does not independently
  verify worker state.
- Use organic provider callbacks only. Do not send synthetic callbacks,
  synthetic reads, replay probes, curl probes, or other manufactured traffic to
  create trial volume.
- Do not use a second or legacy callback-canary deadline variable. The Mongo
  generation and its `expiresAt` are the sole trial clock.
- Never log or paste API keys, authentication values, callback payloads, or raw
  connection IDs.
- Stop immediately for unexpected volume, an affected unrelated provider, a
  breaker transition, or any outbound call that is not explained by organic
  traffic.

## 1. Prepare the staged deployment

1. Confirm the exact production service is Render `mos-tools`
   (`srv-d55jaqkhg0os73a5dd8g`). Do not target QA, workers, `mos-tools-east`,
   or a service selected by a partial name.
2. Activate or confirm the production Mongo operator stop. Record its current
   `stopId`; the timed-trial start uses that value for stale-write protection.
3. Manually suspend **both** production Protractor workers and stop historical
   backfill. Record the operator, time, and evidence in the change ticket.
   This is an attestation, not an automated readiness claim.
4. Stage the following values while the operator stop remains active:

   ```text
   PROTRACTOR_CALLBACK_TRIAL_ENABLED=true
   PROTRACTOR_OUTBOUND_DISABLED=false
   ```

   The first flag enables the callback trial path. The second value is safe to
   stage only because the Mongo operator stop still denies physical
   admissions. Do not stage a competing deadline variable.
5. Deploy the reviewed commit manually with Render autodeploy disabled. Do
   not start workers or historical backfill as part of this deployment.
6. Verify the effective staged configuration and that the operator stop is
   still active. A timeout or unavailable status is a failed gate, not
   permission to proceed.

Do not proceed to activation if the stop is not active, either worker is
running, backfill is enabled, or outbound-disabled has not been staged exactly
as above.

## Isolate one Render replica

Replica isolation remains a recovery control separate from the timed-trial
configuration. Use it when one exact replica must be denied while the web
service remains available; do not use it to manufacture trial traffic.

`PROTRACTOR_OUTBOUND_DENIED_INSTANCE_IDS` accepts either a comma-separated list
or a JSON string array of exact replica identities. Use `RENDER_INSTANCE_ID`
from structured runtime telemetry; do not use an IP address, connection ID, or
credential. Identity values are emitted only as one-way 12-character
fingerprints in policy-denial telemetry.

1. Keep `PROTRACTOR_OUTBOUND_DISABLED=true` while preparing an isolation
   rollout.
2. From Render instance metadata, copy the exact `RENDER_INSTANCE_ID` of the
   blocked replica and set, for example,
   `PROTRACTOR_OUTBOUND_DENIED_INSTANCE_IDS=instance-a,instance-b`.
3. Deploy without suspending the web service. A denied replica continues to
   serve MOS and non-Protractor traffic. Its Protractor cron jobs and drain
   worker are not registered; route-level and transport-level checks remain
   defense in depth.
4. Remove `PROTRACTOR_OUTBOUND_DISABLED` (or set it to `false`) only after all
   replicas have the deny policy. Verify allowed-replica health and organic
   traffic first; do not send a synthetic probe.
5. Filter structured logs for `protractor_outbound_policy_denied`. Confirm the
   expected instance fingerprint and contexts, and confirm upstream Protractor
   request telemetry is zero for that fingerprint. These local denials must not
   appear as upstream 403s or circuit-breaker responses.
6. When an organic GET or POST callback arrives at the denied replica, verify
   HTTP 200 with `status=deferred`, durable unprocessed callback rows, no
   attempt increment, and no enrichment request. Then run queue recovery on an
   allowed replica and confirm the event is claimed and processed there.
7. Verify an unrelated MOS endpoint and a non-Protractor background job on the
   denied replica. Both must remain available.

The deny policy fails closed if non-empty but malformed, duplicated, or if no
stable instance identity is available. Fix the value rather than bypassing
this protection. `PROTRACTOR_OUTBOUND_DISABLED=true` remains the highest
priority control and blocks every replica regardless of the deny list.

### Identity rotation and verification

Render may replace `RENDER_INSTANCE_ID` during any deploy or restart. Before
and after each deploy, compare current instance metadata with the deny list.
If the blocked egress moved to a replacement instance, add the new identity
before removing the old one, deploy, repeat the zero-outbound verification,
and only then prune identities that no longer exist. Treat an unexpected
`missing_identity` or `malformed_policy` denial as a rollout failure.

## 2. Start the 30-minute trial from the platform-admin UI

1. Open **Platform Admin → Protractor Trial** and refresh status. Confirm the
   current stop ID and that the API reports `trialReady: true`.
2. Enter a change-specific reason. Check the explicit attestation for both
   workers suspended and historical backfill off.
3. Select **Start 30-minute timed trial**. The UI sends only the reason, the
   fresh `expectedStopId`, and `workersSuspendedConfirmed: true`; it does not
   accept a user duration or request cap.
4. Mongo activation records the exact start time and a **fresh replay floor**.
   Only organic callback activity after that floor belongs to this trial.
5. Confirm the returned status shows `mode: "timed_trial"`, `startedAt`,
   `expiresAt` approximately 30 minutes later, and a new generation. Treat the
   countdown in the UI as advisory; the Mongo expiry is authoritative.

If the start returns `409`, refresh status and review the new stop ID. Never
automatically retry a stale start or clear. If the network outcome is
uncertain, fetch status to determine whether the generation started; do not
retry the POST.

## 3. Observe organic traffic only

During the live window:

1. Do not trigger a callback, read, replay, or request to manufacture traffic.
   Wait for organic provider callbacks.
2. Observe the timed generation, physical-admission state, upstream request
   classes, pacer waits, connection breakers, provider breaker, callback
   outcomes, and error budget.
3. Compare traffic with the agreed organic baseline. A timed trial has no
   request-count ceiling, but pacer and breaker protections must continue to
   constrain dispatch.
4. Keep both workers suspended and historical backfill off. Do not “restore”
   either one to increase observations.
5. Do not treat zero organic requests as a successful provider canary; record
   the window as inconclusive if no callbacks arrive.

Production log queries are observational only. Restrict telemetry to the
production web service and exclude build services:

```sql
WHERE syslog.host = 'mos-maintenance-mvp-main'
  AND syslog.appname LIKE 'web-%'
  AND syslog.appname NOT LIKE 'bld-%'
```

Never use log counts to enforce, extend, or reopen a generation. Delayed,
truncated, or contaminated telemetry cannot change the Mongo safety state.

## 4. Emergency stop

The **Activate emergency operator stop** action remains available while a
timed generation is live. Enter a reason and submit it if organic traffic or
provider telemetry is unsafe. This action is never automatic and does not
reopen an expired generation.

If the web UI is unavailable, use a production-context Render one-off job for
the exact `mos-tools` service:

```text
npm run protractor:operator-stop -- activate "<incident reason>"
```

The command refuses a non-production service identity and writes the same
operator-stop record used by physical REST and SOAP admission. Confirm with:

```text
npm run protractor:operator-stop -- status
```

If the emergency command or status response is lost, do not repeat an
activation blindly. Fetch status from another trusted operator surface and
then investigate.

Only consider suspending the web service if provider telemetry proves that a
new physical admission occurred after the operator-stop activation timestamp.
An unavailable dashboard, breaker alert, or log query alone is not evidence
that requires suspension.

## 5. Expiry and rollback

At `expiresAt`, Mongo closes the timed generation. The UI may show an advisory
zero clock before telemetry catches up, but it must not reopen or extend the
generation. A later trial requires a newly activated stop, a new stop ID, a
new reason, a new manual worker/backfill attestation, and a new fresh replay
floor.

For an unsafe result or a deployment rollback:

1. Activate the emergency operator stop, using the UI or the production
   one-off CLI above.
2. Confirm physical admissions stop and preserve privacy-safe telemetry.
3. Restore `PROTRACTOR_OUTBOUND_DISABLED=true`.
4. Deploy that disabling configuration manually. Keep Render autodeploy off.
5. Confirm the effective disabled value, both workers still suspended, and zero
   new Protractor upstream calls.
6. Leave the operator stop active until a separate incident owner authorizes
   the next staged change. Never roll back by allowing a known-blocked replica
   to call Protractor.

If a replica must be isolated, use exact stable `RENDER_INSTANCE_ID` values in
`PROTRACTOR_OUTBOUND_DENIED_INSTANCE_IDS`. Identity rotation requires adding a
replacement identity before removing the old one and re-running the
zero-outbound verification. A malformed or missing identity fails closed.

## Existing bounded mode

The API's existing bounded generation remains supported for separately
approved operations with one through three fleet-wide admissions. This UI does
not expose or create that mode. Do not confuse its admission counter with the
timed trial: timed mode intentionally has no request cap and is bounded only
by its fixed Mongo lifetime plus the production pacer and breakers.
