# Shopmonkey controls and printing

Supported order controls are the branded Detect Dog launcher and oil-sticker
button. Native Print/Send/Message remain untouched. Print stays on the
previously approved separate row beneath native Print; Detect Dog floats at
the viewport edge. There are no new DVI,
notes, or provider write-back buttons.

Left click follows the shop's existing open-Print-first preference; otherwise it
generates an immediate sticker. Right click opens Print for interval customization
and keytags. Shopmonkey does not duplicate Tekmetric's inline interval dropdown.

For Shopmonkey subscriptions with keytags but without Maintenance, the Print
panel permits print-only manual customer, vehicle and order-number entry. It
does not call the Maintenance-only order-enrichment endpoint. Required fields,
current order/location and keytag settings must match before printing; changing
orders clears those manual entries.

Explicit logins exchange the original root for an operation-local, short-lived
location session. Canonical location ownership is resolved before access checks;
company-only identity must be unique globally. Nothing learns mappings from the
page. Old sessions without switching provenance require one explicit sign-in.
The server's provider mismatch guard remains in place.

Offline checks:

```
node --test tests/shopmonkey-buttons.test.cjs tests/shopmonkey-page-context.test.cjs tests/shopmonkey-controls.browser.cjs
node --test tests/shopmonkey-keytag-only.test.cjs
NODE_OPTIONS='--require ./tests/helpers/deny-network-egress.cjs --require ./scripts/_stubs/server-only-stub.cjs' node --import tsx tests/shopmonkey-print-scope.smoke.ts
```

Also run the existing extension-location-switching, sticker-location-session,
sticker-location-resolver and extension-shop-lookup smoke tests under the same
network-denying harness.

No production sessions, paid provider lookups, physical printers or live shop
writes were used. Real-session verification still requires an authorized advisor
to check the deployed extension against their current Shopmonkey toolbar,
location identity and printer. This change does not publish the extension or
enable bootstrap.

Active-location detection also observes same-tab Shopmonkey API requests
passively. Only validated-shape company/location identifiers, path and a short
expiry cross into the content script; credentials never cross that bridge.
Decoded session claims are advisory, not verified authentication. Existing MOS
canonical ownership and account-access checks remain mandatory.

Fresh session context takes precedence over storage hints. After it expires
(at most 30 minutes without fresh authenticated activity, never beyond the
observed provider token's expiry) or the order path
changes, printing stays unavailable until new same-tab activity confirms
context. Requests are never generated merely to refresh it. Early observations
can be replayed when the content script starts. Unresolved location and failed
permission loads show an inline status below Print rather than silent absence.

Request headers, bodies and URLs are no longer written to interceptor console
logs. Opt-in diagnostic capture additionally redacts credential headers
case-insensitively. This does not retroactively sanitize previously saved logs.

The Detect Dog launcher is fixed at the viewport's right edge; Print remains
in the order toolbar. Both retain the same server-authorized visibility rules.
First transient permission failures become eligible for retry after two seconds
(on the next normal context scan), backing off to ten seconds for repeated
failures. Explicit access/sign-in/mapping failures retry at thirty seconds.
This reduces the previous fixed ten-second retry penalty; it does not establish
the cause of any particular live startup delay.

Header mileage parsing accepts immediate VIN-adjacent values on the same line,
blank-line-separated values and split outgoing-mileage placeholders, including
nonbreaking spaces. It does not search unrelated maintenance suggestions.

Run `node --test tests/shopmonkey-session-context.test.cjs` for passive-context,
expiry, tab-isolation and logging checks. The browser suite also covers the
early-load bridge, fetch/XHR location changes, visible warning and recovery.
