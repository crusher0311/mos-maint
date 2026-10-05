# Tekmetric button lifecycle verification

The code weaknesses are reproduced with synthetic data; the trigger of the
reported production incident is **not confirmed**. This change does not attribute
the problem to another extension.

## Automated checks

Run `node tests/tekmetric-buttons-lifecycle.cjs` (Chromium on PATH or
`CHROMIUM_PATH`) and `node tests/extension-features-deadline.cjs`.
The browser test executes the real adapter against the sanitized Tekmetric RO
fixture with virtual time and a stubbed Chrome transport. No live API writes occur.
It covers host toolbar replacement, late insertion, hidden anchors, direct RO
transitions, duplicate prevention, floating-control recovery, print/right-click,
hidden/denied settings, hung/rejected messaging, and stale shop responses.
The shared-handler test executes the actual background branch with stubbed
transport, including worker restore, bootstrap, headers, and body-read hangs.

Settings have an 8-second background deadline and a 10-second content-message
deadline. A single request is allowed per current settings generation; retries
back off from 2 seconds to 30 seconds, driven by the existing 2-second poll.
Successful settings refresh after 60 seconds. Same-scope transient failures keep
known preferences/entitlements; shop or identity changes discard them and reject
late results. Print remains ungated on initial settings failure, as before.

The floating launcher is different from the print button: it requires an
explicit `floatingButtonEnabled: true` response. It stays hidden while the
initial shop/account decision is unknown. This intentionally replaces the old
fail-open behavior because it exposed the launcher for users/owners who selected
Off. Chrome's extension icon remains available to open the side panel and sign
in when settings cannot load. A known On or Off decision survives transient
same-scope failures; changing shop or identity hides it until resolved again.

DOM reconciliation uses the existing polling cadence, not a new whole-page
MutationObserver. Recovery normally takes up to 2 seconds after host rendering.

## Support diagnostics

In the Tekmetric tab's DevTools console, filter for
`[MOS Tools] button lifecycle:`. Reasons are fixed strings:
`anchor_missing`, `control_detached`, `settings_timeout`, `settings_failed`,
`settings_transport`, and `context_invalidated`. Each is limited to one message
per minute per tab. No URL, customer data, shop identifier, or token is included.
These are local console diagnostics, not new remotely collected telemetry.
An invalidated extension context needs a tab reload; JavaScript cannot reconnect
an old content script after Chrome replaces its extension runtime.

## Remaining real-browser verification

After installing the packaged version in an authorized test Chrome profile,
confirm the current Tekmetric header selectors on its actual RO and inspection
views, navigate between ROs without reload, and exercise configured print
intervals with a test printer. Check a deliberately hidden preference and a
denied feature. Real Chrome worker suspension, extension updates and physical
printing are not simulated by the DOM transport stub.
Collect the fixed diagnostic reasons if the live incident recurs before
attributing a production cause. No Web Store publication or live shop write was
performed by these checks.