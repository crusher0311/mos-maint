# Shopmonkey controls and printing

Supported order controls are the branded Detect Dog launcher and oil-sticker
button. Native Print/Send/Message remain untouched. Controls stay on the
previously approved separate row beneath native Print. There are no new DVI,
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
