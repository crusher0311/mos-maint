# Protractor storm recovery runbook

Use this checklist only during a coordinated production maintenance window. The
safe default is to keep Protractor outbound traffic blocked and Render
autodeploy disabled until an operator and Protractor agree that the production
egress IP may be tested.

## Safety rules

- Do not suspend the shared MOS web service to control Protractor traffic.
- Keep `PROTRACTOR_OUTBOUND_DISABLED=true` during deployment and initial
  verification. This switch takes precedence over callback, cron, interactive,
  REST, and SOAP requests.
- Do not enable Render autodeploy as part of this rollout.
- Never log or paste API keys, authentication values, callback payloads, or raw
  connection IDs.
- Stop immediately if request volume exceeds the agreed canary ceiling, any
  unrelated provider is affected, or the provider-wide breaker opens.
- A closed-to-open connection or provider breaker transition emits one critical
  `Protractor traffic automatically blocked` ops alert. It includes the scope,
  response class, cooldown, and a one-way connection fingerprint only. Repeated
  failures during the same open period do not page again; a successful recovery
  clears the incident so a later open transition pages again.

## 1. Deploy while outbound remains blocked

1. Confirm Render autodeploy is off.
2. Confirm `PROTRACTOR_OUTBOUND_DISABLED=true` in the production service.
3. Deploy the reviewed commit manually.
4. Confirm the web service and background workers are healthy.
5. Deliver duplicate GET and POST callback probes for a test connection.
6. Confirm callbacks are acknowledged and telemetry shows admitted/coalesced
   outcomes, while Protractor API usage remains at zero.
7. Deliver several callbacks with an unknown connection ID. Confirm they are
   acknowledged, counted in `protractor_callback_quarantine`, and create no
   Protractor API usage.

Do not proceed if any REST or SOAP call is recorded while the switch is on.

## Isolate one Render replica

`PROTRACTOR_OUTBOUND_DENIED_INSTANCE_IDS` accepts either a comma-separated list
or a JSON string array of exact replica identities. Use `RENDER_INSTANCE_ID`
from the structured runtime telemetry; do not use an IP address, connection ID,
or credential. Identity values are emitted only as one-way 12-character
fingerprints in policy-denial telemetry.

1. Keep `PROTRACTOR_OUTBOUND_DISABLED=true` while preparing the rollout.
2. From Render's instance metadata, copy the exact `RENDER_INSTANCE_ID` of the
   blocked replica and set, for example,
   `PROTRACTOR_OUTBOUND_DENIED_INSTANCE_IDS=instance-a,instance-b`.
3. Deploy without suspending the web service. A denied replica continues to
   serve MOS and non-Protractor traffic. Its Protractor cron jobs and drain
   worker are not registered; route-level and transport-level checks remain as
   defense in depth.
4. Remove `PROTRACTOR_OUTBOUND_DISABLED` (or set it to `false`) only after all
   replicas have the deny policy. Verify allowed replica canaries first.
5. Filter structured logs for `protractor_outbound_policy_denied`. Confirm the
   expected instance fingerprint and contexts, and confirm upstream Protractor
   request telemetry is zero for that fingerprint. These local denials must not
   appear as upstream 403s or circuit-breaker responses.
6. Send GET and POST callbacks to the denied replica. Verify HTTP 200 with
   `status=deferred`, durable unprocessed callback rows, no attempt increment,
   and no enrichment request. Then run queue recovery on an allowed replica and
   confirm the event is claimed and processed there.
7. Verify an unrelated MOS endpoint and a non-Protractor background job on the
   denied replica. Both must remain available.

The deny policy fails closed if non-empty but malformed, duplicated, or if no
stable instance identity is available. Fix the value rather than bypassing this
protection. `PROTRACTOR_OUTBOUND_DISABLED=true` remains the highest-priority
control and blocks every replica regardless of the deny list.

### Identity rotation and verification

Render may replace `RENDER_INSTANCE_ID` during any deploy or restart. Before
and after each deploy, compare current instance metadata with the deny list.
If the blocked egress moved to a replacement instance, add the new identity
before removing the old one, deploy, repeat the zero-outbound canary, and only
then prune identities that no longer exist. Treat an unexpected
`missing_identity` or `malformed_policy` denial as a rollout failure.

## 2. Prepare a one-connection canary

1. Agree with Protractor on one test connection and a short observation window.
2. Set the distributed request ceiling to the lowest practical value.
3. Ensure callback and cron sources for all non-canary shops remain paused or
   otherwise unable to consume the canary budget.
4. Record the baseline callback, breaker, and API-usage counters.
5. Confirm no connection or provider breaker is already waiting on a probe.

## 3. Run the controlled probe

1. Set `PROTRACTOR_OUTBOUND_DISABLED=false` only for the coordinated window.
2. Trigger one idempotent read for the canary connection.
3. Confirm exactly one upstream request and a successful response.
4. Wait through the observation window before allowing another request.
5. If the response is 401/403, stop. Confirm the per-connection breaker opens
   and that subsequent requests produce zero upstream calls. Confirm exactly one
   connection-scope ops alert with response class `authentication`.
6. If responses are 429 or 5xx, stop. Confirm bounded Retry-After-aware backoff
   and that the provider breaker prevents continued amplification. Confirm
   exactly one provider-scope ops alert with the matching response class and
   cooldown.
7. Restore `PROTRACTOR_OUTBOUND_DISABLED=true` before investigating any anomaly.

## 4. Expand gradually

Only after a clean canary:

1. Increase the distributed ceiling in small steps.
2. Add a small group of known-good connections.
3. At each step, compare callback admissions, coalesced events, per-connection
   request counts, response classes, and breaker transitions.
4. Hold each step long enough to cover callback and cron traffic.
5. Keep an operator ready to restore the emergency switch immediately.

Render autodeploy remains off until the rollout owner separately decides the
incident is closed.

## Rollback

Set `PROTRACTOR_OUTBOUND_DISABLED=true`. Do not suspend MOS. Confirm API usage
returns to zero, then preserve privacy-safe callback and breaker telemetry for
incident review.

After traffic is stopped, remove or correct
`PROTRACTOR_OUTBOUND_DENIED_INSTANCE_IDS`, deploy to every replica, and verify
identity metadata plus an allowed canary. Only then clear the service-wide
switch. If isolation itself must be abandoned, leave the service-wide switch
on; never roll back by allowing a known-blocked replica to call Protractor.