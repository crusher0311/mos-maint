# Historical Sync administration: local implementation and rollout gates

This feature is based on reviewed production revision
`ae46dfa2591c3f574a45c92232936ff7f312c25d`, not blanket current main.
No production data, provider requests, worker configuration, deployments or
activation were changed by implementation or its tests.

## Admin workflow

Use Platform Admin → Historical Sync. The existing platform-admin authorization,
origin validation, revision CAS, explicit actions and emergency-stop link remain.

- Timezone precedence: explicit history override → existing shop timezone →
  unambiguous retained Protractor location → explicitly confirmed fallback.
- US Windows timezone names are mapped with DST-aware IANA zones. Unknown
  territory/name pairs, invalid saved settings and multi-location responses
  require review. No new provider fetch occurs on page load; metadata can be old.
  Business hours are not inferred from provider timestamps.
- Shared weekly hours remain the compatibility default. Each shop can have its
  own seven-day schedule and optional timezone override. Removing an override
  explicitly returns to the shared policy; it does not edit general shop settings.
- All edits remain drafts until confirmed and saved. A concurrent change or
  uncertain response preserves the draft and requires an explicit reload.
- Enabled saves require a compatible fresh worker heartbeat, live transport,
  no emergency stop, resolvable target identities and timezone. Enabling,
  expanding shops or increasing the history horizon also requires server-checked
  activation confirmation. Disabled drafts can be saved without a worker.
- Status shows timezone/hour sources, history cursor (not a complete-coverage
  guarantee), last attempt, and next eligible window when gates permit it.
  A future eligible window is not a guaranteed start time.

## Worker state is evidence, not a Render control panel

The UI never receives Render credentials and cannot create, resume or suspend
Render services. Those are one-time/operator infrastructure actions. Routine
queue/pause/resume/retry, scope, horizon and hours are managed here.

A missing heartbeat means **provisioning unverified**, not confirmed absence.
Fresh heartbeat states distinguish idle, running, blocked, readiness-only and
failed; old heartbeats show stale, and graceful shutdown records stopped.
Workers publish their deployed commit and protocol version. A runner lease alone
is not proof of current liveness. Last-seen is evaluated when status is refreshed.

The dedicated start command remains:

```
node --require ./scripts/_stubs/server-only-stub.cjs --import tsx scripts/protractor-fleet-history-worker.ts
```

Default `PROTRACTOR_FLEET_HISTORY_WORKER_ENABLED=false` with readiness-only unset
still exits without database/provider work.

After separate staging approval,
`PROTRACTOR_FLEET_HISTORY_READINESS_ONLY=true` with the worker-enabled flag false
allows heartbeat-only operation: no history tick is invoked. This mode writes
only worker-observation metadata on the existing physical-admission document,
does not upsert/reset that document, and cannot satisfy import activation.

To make activation available later, an operator must explicitly approve an
execution-capable worker and set its enabled flag true while scheduling remains
disabled. It can then report readiness without importing. The app's separately
confirmed scheduling enable is the final gate. If a previously enabled config
exists, do not resume an execution-capable worker before reviewing/disabling it.
One instance only. A second live heartbeat owner is rejected.

## Coordinated rollout required

Deploy the compatible web and dedicated worker code before using per-shop
schedules. Old worker code does not understand the added schedule fields.
Keep legacy workers suspended. Do not use an old web binary to save new settings
or an old worker to execute them; rollback must stop admissions and preserve
the compatible readers, stored config, cursors, receipts and pending writes.
Do not reset the callback generation or replay floor or alter transport pacing,
relay requirements, breakers, or emergency controls.

Readiness checks do not independently prove relay availability, database capacity
or organic callback continuity. The existing production rollout checklist still
requires those checks before activation.

For the initial shop-635 rollout, retain explicit `[635]` scope, two-year horizon,
America/Chicago effective timezone, Monday–Friday 07:00–18:00 business hours and
closed weekends. Never clear the rollout list: an empty list means fleetwide.
The code does not install this scope automatically or enable any shop.

## Offline verification

```
bash tests/run-protractor-fleet-history.sh
env -i PATH="$PATH" HOME="$HOME" PROTRACTOR_OFFLINE_ALLOW_LOOPBACK=true \
  NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs --require ./scripts/_stubs/server-only-stub.cjs' \
  node --import tsx --test tests/protractor-history-admin-browser.test.ts
npm run typecheck
```

The fleet suite uses disposable Mongo, fake provider calls and denied external
networking. The browser fixture bundles the actual admin component with an
in-memory API; it is not production authentication or a live provider test.
