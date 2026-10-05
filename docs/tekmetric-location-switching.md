# Tekmetric location switching

## Read-only findings — 2026-10-05

Inspected the shared live Mongo shop records using the bounded, projection-only
`scripts/inspect-tekmetric-location-switching.ts`. No mappings, accounts, sessions,
or production schema were changed.

| Location | MOS shop | Canonical Tekmetric ID | Result |
|---|---:|---:|---|
| VPX Performance | 265 | 11040 | Unique canonical owner |
| Burlington Automotive Service | 266 | 17946 | Conflicts with MOS shop 519 |
| Burlington Automotive service | 519 | 17946 | Conflicts with MOS shop 266 |

All three records share the same enterprise. **Burlington cannot safely print until
an operator chooses the correct record and repairs the duplicate canonical mapping.**
Do not auto-merge users/shops or infer the correct record from capitalization.
Inspect settings, branding, subscriptions, historical data and assignments before
choosing the retained mapping. This repair is outside this code change.

The affected advisor was not identified, so their current account assignment and
the original failing request were not verified. Enterprise membership alone does
not establish an employee's access.

Recent VPX telemetry showed extension **1.35.2** at 2026-10-05 17:01 UTC.
This is observed shop traffic, not proof of the affected advisor's installed
version. The workspace started at **1.35.3** and is bumped to **1.35.4** for this fix. Chrome Web Store publication state,
the affected browser, and a live physical print were not inspected.

## Authority and rollout

- Explicit password or emailed-code authentication records its provenance.
- For a different shop, a root verified session exchanges its Tekmetric page identifier for a
  separate single-shop token. The target is resolved canonically across all shops
  before access is checked. A submitted MOS shop ID is ignored.
- Eligibility uses the **matched account's current explicit shopId + shopIds**,
  with the existing platform-admin exception. It does not union arbitrary
  same-email documents or extend employee access through enterprise membership.
  Legacy owner/admin enterprise expansion is unchanged; this endpoint follows
  modern first-class session assignment rules.
- Derived sessions last at most five minutes and never outlive their root.
  Root revocation/expiry is checked on every derived-token lookup. Target access,
  active status and capabilities are rechecked on each request.
- Basic, provider-bootstrap, legacy and derived sessions cannot exchange scopes.
  Pre-upgrade sessions have no reliable password/bootstrap provenance: they need
  **one explicit sign-in after rollout for cross-location access**, then can switch without further passwords
  during the original authentication lifetime. Do not infer provenance from
  browser-local `authSource`.
- **Apply `drizzle/0036_extension_location_sessions.sql` before deploying the
  server.** The identity queries select these columns, so deploying code first
  would break session reads. The migration runner includes this file. No schema
  migration or deployment was executed by this task.
- Release extension **1.35.4** after the server/migration. The manifest version
  was bumped for release tracking; no extension upload or release was performed here.

## Print context

The saved explicit login is never replaced by bootstrap or a location token.
Each operation captures its own tab, shop, RO, API origin and authentication epoch.
Settings and generation use the same operation-local token (original for a proven
same-shop request, derived for a genuine exchange). Explicit Tekmetric settings
bypass the older shared persistent cache; failed checks cannot reuse another
location's settings. Requests have bounded timeouts.

The worker checks the originating tab URL and navigation revision before and after
network work. Concurrent tabs do not mutate a shared location credential. Worker
startup awaits stored login restoration; no derived token/settings are restored.
The content script checks the shop/RO again immediately before invoking print.
Side-panel print routing uses the originating tab and does not fall back to a
popup when a bound context is unavailable.

## Automated checks

`npm run test:extension-location-switching` exercises real server auth/session/
lookup logic with in-memory stores, actual worker message handlers in a browser
API harness, request concurrency/navigation/logout races, restart restoration,
and the actual shared sticker resolver without native canvas dependencies.
The message harness also replays Customize → OPEN → SWITCH → settings → POST →
originating-tab print using the real panel functions, including visible sign-in,
mapping-conflict and temporary-failure instructions.
It covers A–B–A, custom intervals, revoked assignments/roots, expiry, Basic and
bootstrap limits, conflicting/unknown mappings, provider wording and transient errors.

Also run the existing principal-scope suite (including login/proof/bootstrap
sub-suites), secure-session, enterprise-access, shop-lookup and sticker-cache
tests. `npx tsc --noEmit --incremental false` avoids stale incremental diagnostics.
These tests do not verify a physical printer or the authenticated Chrome UI.

## Same-shop compatibility and Everett verification

Same-shop requests now resolve the canonical Tekmetric mapping and current direct
assignments before deciding whether an exchange is necessary. A verified modern
session bound to that MOS shop and provider can reuse its original bearer even
without password/login-code provenance. This is not a bootstrap elevation or
renewal: the response returns the exact original token and expiry and inserts no
session. Basic sessions still cannot use this exchange endpoint.

An unbound legacy token is reusable only with a known original expiry, an active
matched account, and exactly one directly assigned shop that is also its primary
shop and the canonical target. Enterprise-expanded access and platform-admin
bypass cannot prove same-shop legacy scope. Unknown, conflicting or unavailable
mappings never fall back. Cross-location exchanges retain the provenance and
root-session restrictions.

Fixture verification covers pre-provenance modern and legacy single-shop logins,
zero issuance and unchanged expiry, removed assignments, expired/revoked tokens,
ambiguous legacy scope, mappings and outages. Actual worker/panel functions run
through immediate printing and Customize → settings → generation → original-tab
print after restoration with the server's reuse response. No frontend protocol
change or saved-login replacement is needed.

**Everett live status:** its actual session, matched account assignments, installed
extension and physical print remain unverified. No production access, mutation,
deployment or mapping repair was performed for this change. The separate
Shop-Ware mapping incident is not addressed.

**Safe temporary recovery:** explicitly sign in to MOS in the extension with the
shop's authorized account, then reopen Customize from the current Tekmetric RO.
This records server-owned provenance without widening assignments. If the shop is
unlinked, conflicting or unauthorized, stop and have an operator investigate;
do not retry through a less restrictive endpoint.

After an approved release, verify Everett's original still-valid login (without
first replacing it), immediate and Customize prints, shop branding, two-tab
routing and worker restart. A fresh sign-in alone verifies the recovery path,
not the older-session regression.

## Burlington / VPX operator checklist

1. Resolve the 266/519 canonical mapping conflict; retain historical data and
   account records according to an approved operator plan.
2. Identify the advisor's actual matched login document. Confirm it is active
   and explicitly assigned to VPX 265 and the retained Burlington MOS shop.
   If not, use the existing location-access administration UI.
3. Apply the migration, deploy the server and release/install the updated
   extension. Confirm the installed version in Chrome.
4. Sign in once explicitly. Open a Burlington RO, print both an immediate and
   custom-interval sticker; verify logo, phone, units and interval against that
   shop's settings.
5. Switch to VPX, repeat both methods, then switch back to Burlington without
   entering the password again. Repeat from the side panel.
6. Open both shops in separate tabs and print concurrently. Navigate during
   generation: stale results must not print. Stop/restart the service worker
   and repeat in both tabs.
7. With an approved test account, revoke target access and confirm both settings
   and printing are denied. Test an unlinked ID, duplicate mapping and simulated
   network failure only in fixtures/QA, never by disrupting live mappings.
8. Confirm error messages name Tekmetric and that none of the failure paths
   produces the previous shop's branding.
