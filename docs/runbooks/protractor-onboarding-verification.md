# Protractor onboarding: production verification

## Deployment preparation handoff

The operator requested deployment preparation after identifying the Sync Now
failure. This deliverable is the narrowly scoped code fix, not production
activation or a claim that new-shop onboarding and callbacks were verified live.

- Release only the Protractor manual-sync route, the Protractor section of
  Integrations settings, its regression test/runner, and this evidence record.
  Do not deploy the whole current main branch without reviewing unrelated work.
- Run `npm run test:protractor-onboarding` in the selected release checkout.
  This suite strips inherited credentials and denies network egress.
- No schema migration, secret change, traffic-policy change, worker restart,
  callback-generation reset, or history import is required by this fix.
- Preserve the current relay requirement, shared pacing, breakers, emergency
  stop, development egress denial, and callback replay floor.
- At a separately authorized service-specific release, verify the exact live
  revision and actual runtime policy. Recheck worker suspension; the observations
  below are timestamped, not ongoing attestations.
- Verify one authorized Test/Connect/reload flow and invalid credentials.
  Confirm Connect makes no `/api/protractor/sync` request, pending history is
  visible, and a restricted Sync Now returns a clear 409 without work starting.
- Check callback bookkeeping separately from organic delivery/application.
  No synthetic provider writes, old-backlog replay, or broad imports.
- If rollback is necessary, retain saved connections and sync cursors. Never
  disable admission protections to compensate for the old UI.

The production app was deliberately not started in this fork because its stores
are shared with production. The preview screenshot attempt failed; signed-in
rendering remains unverified.

Preparation checks passed: `npm run test:protractor-onboarding` (all five test
files) and `npm run typecheck`, both run without inherited credentials and with
network egress denied. A production build and post-release verification remain
release gates; neither is claimed by these checks.

### Sensitive attachment release gate

Completion review identified a callback credential and an email address in the
uploaded screenshot. The screenshot is now untracked and excluded from Git and
deployment packaging. It was absent from the inspected `main-repl/main` tree,
but remains in earlier task/checkpoint commits and a local backup reference.
Untracking does **not** remove those historical copies, and external exposure
has not been established or ruled out.

Release only the clean final source diff/squashed tree, never the earlier
attachment-containing commits. Do not publish or distribute checkpoint history.
If those commits or the screenshot were shared outside the authorized operators,
coordinate callback-token rotation and provider callback reconfiguration before
sign-off, and address the exposed historical copies with the repository owner.
No token was rotated automatically: an uncoordinated rotation could break live
callbacks. No callback credential is reproduced in this document.

## Read-only observation — October 20, 2026

This is **not a restoration sign-off**. No deployment, production configuration
mutation, provider request, worker change, or database write was performed.

The operator clarified that onboarding should work for every new Protractor
integration, not a selected-shop exception.

### Confirmed evidence

- Render inventory identifies production `mos-tools` as
  `srv-d55jaqkhg0os73a5dd8g`, serving
  `https://mos-maintenance-mvp-main.onrender.com`.
- Its latest live deployment is commit
  `77310a4179d6a4b0651131091531c87cbccff8cc`, finished
  October 19 at 16:32:37 UTC.
- Both `backfill-drain-worker` and `mos-maint-background-v2` were suspended.
  The web service was not suspended. Render reported autodeploy enabled.
- Saved service settings report callback trial enforcement enabled,
  outbound-disabled false, relay-required true, and relay mode `relay`.
  These are saved settings, **not proof of the running process environment**.
- A bounded direct read of the shared physical-admission record at
  October 20, 11:03:48 UTC found the operator stop inactive and a continuous
  `live` generation with scope `callbacks_and_interactive`,
  `requiresCallback=false`, `requiresRelay=true`, and worker suspension
  attested. Its start/replay floor remains September 15, 11:52:46.690 UTC.
- The provider breaker record had no `openUntil` or `probeUntil` fields in
  the projection. Per-connection breaker state was not verified.
- The live commit contains the authenticated, shop-scoped validation wrapper.
  Comparing its onboarding routes, onboarding helper, and interactive-context
  module against this checkout found no differences.
- The offline bounded-transport smoke test passed with network egress denied.
  It checks credential rejection, one physical attempt, deadlines and guard
  failures. This is not evidence of successful production onboarding.

### Conclusion and remaining evidence

The shared admission record already permits authenticated staff activity
generally; it is not a one-shop allowlist. A missing global activation is not
established. Do not disable trial enforcement, reset the generation, move the
replay floor, or deploy unrelated main changes to address an untraced error.

The dashboard source calls POST `/api/settings/protractor/test` for Test and
POST `/api/settings/protractor` for Connect. The actual failing team's host,
request timestamp, response code, and authenticated shop context have not been
identified. Runtime environment mismatch, another host, and connection-specific
restrictions remain unverified possibilities, not diagnoses.

**No-go for declaring restoration complete.** Correlate a current failed Test
or Connect request with production runtime evidence. Do not collect credentials
or session tokens in a support transcript. A successful authorized connection
must still be verified through Test, Connect, reload, and pending-history status.
Callback bookkeeping and organic delivery/application require separate evidence;
neither was verified here.

### Follow-up: Sync Now screenshot

The operator supplied a screenshot showing **Connected to Protractor**, with
the callback-canary error beneath it, and identified **Sync Now** as the failing
action. Do not reproduce its callback URL/token in diagnostics.

Source tracing identifies POST `/api/protractor/sync` as that button's endpoint.
The page and route are unchanged from the verified live commit above. This route
does not establish interactive validation authority: it starts detached backfill
for incomplete shops, reads active work orders, and fans out into template,
vehicle and deferred-work fetches. Its first guarded provider request therefore
can return the exact callback-canary error shown. This is distinct from the
already-guarded Test/Connect path. The same page also automatically called Sync
after successful Connect and misleadingly promised background progress.

The fork now removes automatic Sync after Connect, displays pending approved
history, removes the promise of nightly catch-up, and checks background admission
before any manual-sync configuration lookup, database work, or detached
backfill. Restricted/unavailable admission returns HTTP 409 with code
`PROTRACTOR_HISTORY_SYNC_RESTRICTED` and says the saved connection is unchanged.
It does not grant bulk sync an interactive capability.

Offline manual-sync admission/UI-source regression checks and the existing
onboarding route/staged-worker tests passed with network egress denied. The
signed-in UI and a real post-change onboarding flow have not been verified.
These edits are not deployed. Actual callback delivery/application remains
unverified. The screenshot establishes the reported operation, not a successful
new connection or persisted reload.

No production rollback is needed for these observations. If a later authorized change
requires rollback, preserve saved credentials, connection binding and history
cursors. Use the existing emergency controls for an incident; never delete
connection state or reopen old callbacks as rollback.
