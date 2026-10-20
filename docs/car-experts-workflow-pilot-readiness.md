# CAR Experts Shop Workflow DVI pilot

## Status

Preparation only. No activation, new provider writes, or end-to-end demonstration
has been performed in this work. Do not describe the pilot as enabled.

The user approved handing off the tested implementation for merge and tracking
live activation separately. This handoff does not claim the original end-to-end
live pilot is complete. Provisioning, serving-build checks and the actual native
demonstration remain required in the activation follow-up.

## Current authorization

The user accepted the documented unresolved provider test risks and explicitly
requested testing the whole check-in process, not restriction to the original
synthetic RO 3586.

The working scope is synthetic CAR Experts Protractor check-ins, including newly
created test visits/orders, followed by saved staff evidence, explicit selection,
confirmation and native inspection write-back. Existing customer orders, other
shops, priced recommendations, customer publication and messaging remain excluded.
New test records need durable provenance so a browser assertion, VIN, order
title or supplied GUID alone cannot authorize a write.

This is an accepted-risk pilot exception, **not** certification of provider
concurrency protection or upstream termination. The existing certified durable
provider contract must not be satisfied by fabricated capabilities. Keep
uncertain attempts visible and never automatically resend them.

## Bounded read-only readiness observation

On 2026-10-20, bounded reads of the configured application Mongo database found:

- Shop 66: name `CAR Experts Protractor`, provider `protractor`.
- No enterprise membership found by numeric/string shop ID; no enterprise
  reference on the shop document.
- No standalone staff inspection configuration.
- Staff inspection admissions therefore remain disabled.
- No approved default sheet, sheet versions or staff rules were available in
  that configuration.

These reads used three projected `findOne` queries with three-second server
deadlines. No settings, records or indexes were changed. They do not verify
the serving deployment, provider credentials, fresh user membership or current
provider work-order state.

## Approved configuration

- The user approved the versioned inspection sheet
  `manual-safety@1` (Manual vehicle inspection), with evaluation notes for rated
  items, tire and brake measurements including original units, and battery
  test fields. Photos are optional.
- The user approved retention of test evidence, media and durable receipts without
  automatic deletion until a separately approved cleanup.
- Rollback owner: the requesting operator ("me").

Existing roles remain authoritative: technicians document findings;
advisors/managers/owners review. New staff permissions are not implied by the
pilot approval.

## Implemented, not activated

The accepted-risk pilot is a separate native-inspection-only lane, not a fabricated
`VerifiedProtractorCapabilities` adapter. Certified durable enrollments remain empty.

- Walk-in intake can load the approved synthetic customer and vehicle. Staff still
  explicitly confirm identity, check in and create an official ticket.
- New orders must have a confirmed persisted workflow ticket intent, a matching
  server-derived order GUID and the exact approved synthetic contact/vehicle.
  Neither a title, browser assertion, VIN match nor a linked customer order qualifies.
  This supports multiple **new** synthetic orders, not arbitrary real customers or
  new customer/vehicle creation. Only one open intake per test vehicle is allowed
  by the existing workflow; close the prior test visit before another check-in.
- Advisor/manager/owner review must match current saved evidence. Explicit selection
  freezes notes, measurements with original units, result labels and line IDs.
  Photos are retained internally, not transmitted.
- Preview and admission persist in the staff shop aggregate. Admission shares its
  CAS with evidence saves. One admitted operation owns the target permanently.
  A successful admission acknowledgment permits one native inspection POST.
  Lost acknowledgment, process death or any subsequent click permits only status
  access/reconciliation, never replay. A new key cannot create another package.
- Strict exact-ID readback compares unrelated order fields/packages and the added
  inspection. Provider-added fields or normalization not understood by this pilot
  remain conflicts rather than being silently accepted. Partial/conflict evidence
  is retained even if a later read appears to match.
- Dashboard/extension legacy pushes for shop 66 are permanently blocked in this
  build, including rollback, so they cannot bypass pilot ownership. Other shops
  are unchanged. No priced-work composer is reachable from this pilot.
- A readback match is an observation, **not** proof that an unacknowledged upstream
  request terminated or that other editors were fenced.

## Operator sequence — not executed

Do not run these commands from the task fork before the merged serving build is
verified. Provisioning pilot fields while the older strict configuration parser
is serving can make staff inspection configuration unreadable.

In the authorized operator environment, using the existing secrets and transport:

```
node --import tsx scripts/configure-car-experts-workflow-pilot.ts plan
node --import tsx scripts/configure-car-experts-workflow-pilot.ts provision --operator-approved
node --import tsx scripts/configure-car-experts-workflow-pilot.ts activate --operator-approved --serving-build-verified
```

The last flag is an **operator attestation**, not an automated deployment check.
Verify the current serving release and authenticated endpoints first. The script
rejects changed shop identity, enterprise governance or canonical PG identity mode
rather than overriding them. Provisioning retains existing configuration and sets
new admissions off. Activation sets only shop 66's workflow/DVI feature overrides
and approved staff/pilot gates; it does not change subscription tiers or customer
publication. Existing staff roles and fresh membership remain required.

Labels provisioned for this accepted-risk test are `OK`, `Requires Future Attention`
and `Required`, from the previous synthetic roundtrip, explicitly **not independently
verified shop configuration**. Record actual shop-native rendering during the live
demonstration. Do not silently relabel this evidence as certification.

Activation writes are not a multi-document transaction. If an operator command
loses its response, inspect exact shop flags/configuration and rollout records
before another action; do not assume the command failed or retry blindly.

### Required live demonstration

In `/dashboard/shop-workflow`, select CAR Experts Protractor and:

1. Open a walk-in, load the synthetic pilot vehicle, enter test concerns/mileage,
   confirm identity and check in. Explicitly create the official ticket.
2. Initialize Manual vehicle inspection v1, save findings with required original
   units/notes, reload and verify the saved values. Use an authorized advisor,
   manager or owner to record review.
3. Select saved findings, preview the exact target and content, acknowledge the
   documented risks, then explicitly send.
4. Record the actual native order/package/line IDs, rendered labels, unchanged
   pre-existing order content, result state and serving release. HTTP success is
   not demonstration evidence. Partial/pending/conflict means stop, not resend.

This live sequence, fresh staff-account verification, provisioning, activation and
serving-runtime checks are all **outstanding**. Offline fixtures do not satisfy them.

Rollback must stop new pilot admissions while retaining evidence, media,
synthetic provenance, target ownership, request IDs, status access and receipts.
Disabling a pilot must never redirect its unresolved targets to legacy writes.

```
node --import tsx scripts/configure-car-experts-workflow-pilot.ts rollback --operator-approved
```

Rollback clears only shop 66's staff admission list and pilot admissions flag.
It retains entitlements/read permission, configuration, inspection evidence,
operations and media. It does not cancel an already admitted upstream request.
Do not roll back to a pre-pilot build that lacks the permanent legacy-routing fence.

## Offline verification

All tests below use isolated loopback storage and deny external egress. No
production provisioning or provider writes were performed.

- 52 repository/access/intake/binding/visit/pilot tests passed, including actual
  workflow-created Concern packages and strict whole-order readback regressions.
- 32 existing certified-durable regressions passed.
- Chromium staff smoke passed: save/reload, photo persistence, advisor review,
  rollback with authorized read-only access.
- Chromium pilot smoke passed: persisted preview and send, response loss after
  headers for each, reload recovery, read-only reconciliation, exactly one fake
  native write. This uses real isolated Mongo persistence, not localStorage evidence.
- TypeScript check and whitespace checks passed.
- Isolated pilot UI screenshot checked; **signed-in production UI not verified**.

```
PROTRACTOR_OFFLINE_ALLOW_LOOPBACK=true \
NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs --require ./scripts/_stubs/server-only-stub.cjs' \
node --import tsx --test tests/workflow-dvi-pilot.test.ts tests/staff-inspection.test.ts tests/staff-inspection-access.test.ts tests/auto-dvi-workflow-binding.test.ts tests/shop-dispatch-intake.test.ts tests/auto-dvi-visits.test.ts tests/auto-dvi-visit-routes.test.ts

# Use the same environment prefix for each browser test; run sequentially:
node --import tsx tests/browser/workflow-dvi-pilot.smoke.ts
node --import tsx tests/browser/staff-inspection.smoke.ts
npm run test:auto-dvi-durable
node_modules/.bin/tsc --noEmit
```
