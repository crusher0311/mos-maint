# Disabled export deployment — 2026-10-23

User approved deploying the verified export-only candidate and staging a
$25/month dedicated export worker with exports disabled.

## Applied configuration

- Pushed only `release/protractor-export-pg-20261023`, commit
  `ae1445a4afbd2f50e56cf3de226ad2564c49e51f`. GitHub main was not changed.
- Pinned `mos-tools` to that branch with auto-deploy off and requested exact
  commit deployment `dep-dbdm36hsrm7s73c7fql0`.
- Created `mos-protractor-export-worker`, ID `srv-dbdm35brjlhs73dp0gug`,
  Oregon, standard ($25/month compute tier), one instance, Node 20,
  auto-deploy off and 60-second shutdown grace.
- Worker start command: `node --import tsx workers/export-only.ts`.
- Worker build command: `npm ci --include=dev --legacy-peer-deps`.
- Suspended the worker immediately after creation. Its creation may initiate a
  build; this is not evidence that a worker image is live or ready to consume.
- Explicitly set PROTRACTOR_EXPORTS_ENABLED=0 on both services.
- Generated a random 32-byte encryption key in operator memory and stored it
  directly in Render on the two intended services. Verified matching readback
  without logging the key. No key is stored in project files.
- Linked the existing restricted PG credential group only to web and export
  worker. Shared/raw-source PG credentials were not changed.
- Worker has selected source/identity configuration copied from the effective
  web configuration, not unrelated provider API keys or general worker startup.

No recipient was configured, no delivery was activated, and no reporting or
backfill worker was resumed. The callback worker remains on main.

## Verification boundary

Configuration readback passed: exports off, keys match, restricted PG group
linked to exactly two intended services, worker suspended.

Web deployment and runtime verification completed at 2026-10-23 13:50 UTC.
The monitor confirmed:

1. Render live status for the exact candidate commit `ae1445a4`.
2. Public HTTP 200 from the Render-reported production URL.
3. Authenticated export cron response `{"skipped":"disabled"}`.
4. Export worker still suspended and unrelated callback/background services
   unchanged.

The disabled deployment is complete. Recipient configuration, worker activation
and an actual production delivery remain unperformed and require approval.
Signed-in UI was not verified during this deployment; the runtime check used
the authenticated cron endpoint and a public page request.

Sanitized rollout receipt, updated by that monitor:
`generated-artifacts/reporting-snapshots/export-disabled-deployment-20261023.json`.

Do not assume a future main push updates this web service: branch and automatic
deployment are deliberately pinned. Returning web to main requires review of
the combined release, not a blind configuration reset.

## Approved sender correction and fictional receiver check

On 2026-10-23, user approved deploying the IPv4 pinning correction and sending
one fictional test, with real exports still disabled.

- Candidate `95c1f5d2` extends the export-only release by exactly two files:
  sender address-family handling and its real loopback socket regression test.
- 13 focused tests passed in the isolated candidate. Main-workspace typecheck
  also passed before packaging; Render performs its normal full build.
- Deployment requested: `dep-dbdmf3mi0phs73aaa5f0`. No settings were enabled,
  and the dedicated worker remains suspended.
- Test runs only after exact-commit live verification and disabled-runtime
  checks. It uses the released sender module from the operator environment,
  not the suspended production worker.
- Test payload contains zero records and is explicitly marked synthetic.
  The destination was supplied by the user for testing; no customer/provider
  records are loaded. MOS shop 298 is the selected Telle store context.
- One POST only, with an admission receipt written before transmission.
  No automatic retry after an ambiguous response.
- A matching ACK proves connectivity/protocol acceptance only. The ephemeral
  test signing key is not a configured production destination secret, so this
  does not establish receiver signature validation or durable deduplication.

Completion evidence:
`generated-artifacts/reporting-snapshots/export-transport-deployment-20261023.json`
and `export-fictional-webhook-test-20261023.json` in that same directory.
The fictional-test receipt is created only when the post-deploy test begins.

### Result

At 14:14 UTC the corrected release was live and runtime-verified with exports
disabled, worker suspended, and unrelated services unchanged. One fictional
POST received HTTP 200, but the response did not contain the exact matching
X-MOS-Acknowledgment header. Delivery is therefore unconfirmed, not accepted.
No retry was performed. The receiver must acknowledge the incoming delivery ID
after committing the batch before another test can establish protocol acceptance.
