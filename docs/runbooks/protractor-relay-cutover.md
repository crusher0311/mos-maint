# Protractor relay cutover

No live Protractor, AWS, or relay test is authorized yet. Validate only with
synthetic local traffic until an explicit production-test approval is given.

## Staged enablement

1. Keep `PROTRACTOR_OUTBOUND_DISABLED=true` while deploying and validating
   configuration. The global outbound stop and local deny policy must remain
   authoritative.
2. In QA, use the relay only with synthetic local fixtures. Confirm REST and
   SOAP signing, response mapping, timeout behavior, and that failures never
   fall back to direct traffic.
3. In QA, set `PROTRACTOR_RELAY_MODE=relay-read-only` for an executable
   process-wide validation: only REST `GET` requests use relay; REST
   mutations and all SOAP remain direct. Observe relay rejection/error
   metadata and existing metrics.
4. After approving the read-only validation, set
   `PROTRACTOR_RELAY_MODE=relay`; all requests then use relay. Keep writes
   disabled by the operational outbound stop until that decision is complete,
   then explicitly resume writes while retaining idempotency/retry controls.
   Never log target query strings, credentials, request headers, or bodies.

Relay modes (`relay-read-only` or `relay`) require
`PROTRACTOR_RELAY_MODE` plus
`PROTRACTOR_RELAY_URL=https://protractor-relay.mos.tools/relay`, and a shared
`PROTRACTOR_RELAY_HMAC_SECRET` of at least 32 UTF-8 bytes. Configure secrets
only in the deployment secret store.

## Rollback

Stop outbound traffic first. Set `PROTRACTOR_OUTBOUND_DISABLED=true`, then
explicitly set `PROTRACTOR_RELAY_MODE=direct` and redeploy. After verifying the
direct configuration and receiving approval to resume, clear the outbound
stop. Relay transport errors must never trigger automatic direct fallback,
especially for writes.