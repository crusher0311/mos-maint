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
