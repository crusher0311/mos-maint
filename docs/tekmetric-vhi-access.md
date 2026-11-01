# Tekmetric VHI access diagnosis

## Evidence collected 2026-10-31

- The supplied worker log shows successful explicit verified login and token
  verification (200), followed by feature SHOP_FORBIDDEN, labor/VHI scoped lookup
  failures for Tekmetric 14245, missing sticker tab context and relay 403s.
  It does not include an effective principal shop or expanded context. Restored
  cached shops do not prove current authority. Repeated login is not a remedy.
- Ran `scripts/inspect-tekmetric-vhi-access.ts`: bounded, projection-only reads
  with five-second query limits returned exactly MOS 63, Tekmetric 14245,
  provider tekmetric. No mapping, membership, session, or provider data changed.
  This excludes a missing/duplicate canonical mapping at inspection time.
- No affected-account identity/session query was performed: the log does not
  supply an unambiguous session identifier, and same-email accounts must not be
  merged or assumed interchangeable.
- Replit deployment metadata reports no deployment for this task fork. The
  supplied production URL's public `/api/extension/version` returns 1.3.1, also
  hardcoded in the workspace route. That is not a server commit or evidence of
  the installed browser version. The serving server revision is unverified.

## Demonstrated defect versus unresolved incident facts

The worker used operation-local location authorization for printing but sent
Tekmetric VHI, features and labor reads with the original shop-bound login.
An authorized multi-location account with a root bound to A therefore failed
at B. Offline tests execute the actual worker routing against synthetic A,
14245, A contexts and require scoped credentials; the unmodified routing cannot
pass these cases. Feature dispatch has a separate branch and is tested too.

This is consistent with, but does not conclusively explain, the original log.
Denied account membership, wrong session binding and stale/missing provider-tab
context remain distinguishable possibilities until the affected request is
observed. The role-only VHI admin test is not established as the root cause:
projected first-class users already include their bound shop for both admin
representations. It was deliberately not converted into a wider admin bypass.

## Repair and authority

Tekmetric foreground reads, including the separate vehicle-history panel, use the existing server-checked location exchange,
as does the token relay. The saved root login is not replaced. The server checks
canonical ownership and the matched account's current authority; scope,
capability, expiry, revocation, provenance and product gates remain in place.
Basic/bootstrap sessions are not promoted. Platform-admin web cookies confer
no extension authority. No mappings are learned and no provider is reconnected.
First-class Tekmetric plan lookup uses canonical provider fields, not the
cross-provider compatibility fallback.

Feature results recheck scope and active tab after asynchronous work. Plan results
also compare account/session discriminator and originating tab before rendering
or caching. The location request checks login epoch, navigation revision and
shop/RO before and after network work. Labor rules retain their existing stale
response checks and fail-closed auto-apply behavior.

Location failures distinguish missing mapping, denied access, conflict and
temporary lookup failure. Server diagnostics contain only outcome/provider,
assurance and a provider-match boolean, not users, tokens, VINs or other shops.
VHI's legacy lookup failure offers assignment/mapping recovery guidance and
explicitly says history has not been checked.

## Verification

Passed with credentials removed and network egress denied:

- extension-location-switching (including both admin representations and string IDs)
- sticker-location-session (concurrent tabs, navigation, logout and failed exchanges)
- extension-sticker-messages (actual worker VHI/vehicle-history/features/labor dispatch and printing;
  history A → B → A, rejected late responses and no history fetch after scope denial)
- sticker-location-resolver
- extension-principal-scope
- extension-shop-lookup
- extension-route-guard
- extension-features-deadline (actual feature branch, scope exchange, stale tab response)

Run TS suites with `node --import tsx tests/<name>.smoke.ts`, rather than the
tsx CLI, whose IPC socket is rejected by the offline network guard.
`npm run typecheck`, JS syntax checks and `git diff --check` also pass.
No signed-in production VHI or physical provider action was exercised.

## Operator-only verification before claiming the shop restored

1. Record the serving server commit and affected installed extension version.
   Confirm the existing location-session provenance migration is installed.
2. With approved access, correlate one failing request to its effective
   principal provider/shop, matched account's explicit assignments, tab ID and
   current Tekmetric page. Do not collect bearer tokens or infer authority from
   the Platform Admin shop list.
3. Confirm the location exchange resolves 14245 to 63. Missing mapping,
   access denial, context change and temporary lookup failure require different
   remedies; no retry or re-login should silently widen authority.
4. On the intended RO, confirm features and VHI load for an authorized account,
   switching away cannot repaint old data, and an unassigned account is denied.
   Confirm labor rules remain unapplied if verification fails.
5. Any membership/mapping correction requires separate explicit approval.
   This work did not deploy or release the extension, migrate production, or
   establish that either reported account currently has access to MOS 63.
