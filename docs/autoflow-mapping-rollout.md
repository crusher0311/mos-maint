# AutoFlow number and dashboard workflow rollout

## Status and boundaries

This change provides code and offline verification, **not a production fix already applied**.
Do not deploy, attach numbers, change provider credentials, replay webhooks, or run
backfills from the isolated task environment. Development Mongo is production.
Use the authenticated Platform Admin controls for the authorized rollout.

Number mapping and workflow mapping solve independent problems:

- **Number mapping:** extension pages at `app.autoflow.com/shop/615/...` resolve to the correct MOS shop.
- **Workflow mapping:** existing AutoFlow events determine which standalone vehicles appear on the dashboard.

## Preflight: re-confirm ownership

The reviewed target is AutoFlow v4 number **615**, **Grand Rapids Motorcar Service**,
internal **MOS shop 432**, domain **grandrapidsmotorcar.autotext.me**.
These identifiers must remain separate. Never renumber MOS 432 or change its domain,
provider assignments, or credentials to match 615.

Read-only checks on September 17, 2026 found no numeric alias on this shop and no
unresolved record for 615. This is historical evidence, not permission to skip a
fresh ownership check.

1. Confirm with an authorized shop contact that the current AutoFlow page belongs
   to Grand Rapids and shows `/shop/615/`.
2. Sign in as a **platform admin**, then open
   `/platform-admin/autoflow-numbers` (not the separate `/admin` area).
3. Refresh and inspect Identity conflicts and Current mappings. Confirm MOS 432
   still has the name/domain above. Stop if ownership or identity differs.
4. Record the current numeric aliases and workflow rules for rollback.
5. In **Manual number attachment**, enter `615`, choose Grand Rapids / MOS ID 432,
   and review the ownership confirmation before submitting. A previously unseen
   number does not need to appear in Unresolved numbers first.
6. If the server reports an ownership conflict, stop. Do not detach another shop's
   number to bypass the protection without a separate ownership investigation.
7. Verify the success notice and refreshed Current mappings show 615 on MOS 432.

## Review the workflow classifications before saving

Use the separate **Per-shop workflow mapping** section and select MOS 432.
Review the observed label list and its sampling bounds (90 days, at most 5,000
deduplicated event metadata rows and 100 displayed labels). The dashboard itself
continues to use its existing 30-day event window. No historical replay is needed.

The following labels were observed during the September 17 investigation. The
table is a **proposed configuration for explicit operator review**, not an
automatically applied classification:

| Observed label | Proposed treatment |
| --- | --- |
| Checkin/Advisor intro | Active |
| Safety/Reliability Insp | Active |
| Estimating (Service Consultant) | Active |
| Waiting on Parts | Active |
| Servicing | Active |
| APPROVED,Parts Here | Active |
| Req. Approval | Active |
| Ready | Active — confirm the vehicle remains on-site awaiting pickup |
| Warranty Claim | Active — confirm this is an on-site vehicle, not an administrative claim |
| QC Inspection | Active |
| Appointment | Excluded |
| Close | Closed |

Confirm every classification with the shop's actual workflow semantics. In
particular, do not assume "Ready" or "Warranty Claim" means the vehicle is still
present. Punctuation remains significant (`APPROVED,Parts Here` is one label).
Only case and whitespace differences are normalized.

Unconfigured shops retain the original six active labels and `Close`; the editor
shows these known defaults rather than guessing all observed labels are active.
When creating the custom mapping, retain or remove those defaults deliberately.
Unmapped labels stay **Unknown / review required** and never create an active
vehicle by themselves. A later unknown event does not erase prior explicit active
evidence; an explicit Closed or Excluded event does. A strictly later Active event
can reopen a vehicle. Equal-time close/exclusion wins.

Save the reviewed mapping. This affects the next evaluation of already-received
events, and sends a shop-scoped dashboard refresh signal. Appointment-only and
closed vehicles should remain absent. Existing VIN/mileage eligibility filters
still apply; a correctly classified event with missing VIN or mileage is not proof
of a mapping failure.

## Verify the two fixes separately

### Extension identity

- Open the shop's actual `/shop/615/` page with a user assigned to MOS 432.
- Refresh the extension context and confirm it selects Grand Rapids / MOS 432,
  without silently selecting another shop.
- Confirm the v3 domain still resolves correctly. Number attachment must not
  change it.
- If identity fails, investigate number ownership, user shop access, and extension
  context independently of dashboard workflow settings.

### Dashboard visibility and live refresh

- Keep an authenticated MOS 432 dashboard open before saving the workflow rules.
- After saving, allow the existing visible-tab polling interval (15 seconds);
  confirm eligible vehicles appear from the already-received events, with VIN,
  mileage, RO, and DVI presentation intact. No new login is needed.
- Confirm Appointment-only and Close vehicles remain absent.
- On the next naturally occurring Active/Close/Active sequence, confirm removal
  and reopening in time order. Do not manufacture production webhooks for this test.
- Check one combined primary-provider/AutoFlow vehicle: it should remain one row,
  keep the primary provider's identity fields, and show only this shop's DVI data.
- Check an unrelated shop: AutoFlow updates at MOS 432 should not trigger its
  dashboard refresh. Legacy global provider notifications retain existing behavior.
- A failed reload should retry on a later poll rather than consume its change token.

Only report the live shop fixed after **both** identity resolution and independent
dashboard visibility checks have succeeded. Record results and time of verification.

## Rollback through the same authenticated controls

- **Number only:** remove 615 from MOS 432's Current mappings, review the confirmation,
  and verify it is no longer listed. Audit history is retained; the unresolved
  entry reopens. A later eligible extension auto-learning attempt can relearn an
  unattached number under existing behavior, so verify resolution separately.
  Do not remove unrelated aliases or alter MOS ID/domain.
- **Workflow only:** restore the rules recorded during preflight. If the shop had
  no custom mapping before rollout, use **Reset to defaults** and confirm. This
  removes the override and restores legacy classification, which may again hide
  Grand Rapids' custom stages. Wait for the open dashboard to refresh.
- Neither action deletes events, customer data, DVI results, or provider credentials.

## Offline verification

The implementation is tested with fake repositories, captured dashboard aggregation,
and real admin React components in a fixture-only browser harness. No production
credentials or data are needed. Focused checks are runnable with:

```sh
npm run test:autoflow-visibility
npm run lint:direct-db
NODE_OPTIONS='--require ./scripts/_stubs/server-only-stub.cjs' \
  npx tsx tests/autoflow-admin-route.smoke.ts
NODE_OPTIONS='--require ./scripts/_stubs/server-only-stub.cjs' \
  npx tsx tests/autoflow-workflow-route-auth.smoke.ts
NODE_OPTIONS='--require ./scripts/_stubs/server-only-stub.cjs' \
  npx tsx tests/autoflow-dashboard-aggregation.smoke.ts
npm run typecheck
```

`test:autoflow-visibility` is included in the existing
`test:autoflow-admin-mappings` smoke chain, so the normal `npm run build`
prebuild lifecycle runs these focused regressions automatically.

The other `tests/autoflow-*.smoke.ts` and `tests/dashboard-*.smoke.ts` fixtures cover
repository identity protection, workflow validation/storage modes, DVI merging,
marker isolation, and failed-refresh retries. Browser fixture scripts and their
usage live under `tests/browser/`.

Verification in the isolated environment: focused regression tests, browser
controls, `npm run typecheck`, `npm run lint:direct-db`, and
`npm run lint:unauthed-routes` passed. The normal `npm run build` lifecycle was
run in an environment-file-free copy and reached the existing print-queue smoke
tests, where the native canvas dependency failed to load `libuuid.so.1`.
An earlier direct Next compilation succeeded, but its page-data collection
encountered the same missing native library. Neither result establishes a
successful full production build or a deployment verification.