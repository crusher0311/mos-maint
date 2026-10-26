---
name: Shopmonkey extension placement
description: User-selected placement of injected controls on the Shopmonkey order page.
---

Place MOS controls on a separate row below Shopmonkey's native Print toolbar,
not beside Print or in the Add Tag row.

**Why:** The user explicitly chose this position after supplying the real
order-page markup, replacing the earlier Add Tag placement.

**How to apply:** Keep native actions intact and use this placement for
future Shopmonkey order-page controls.

Use the standard branded launcher/print imagery but expose only implemented
Shopmonkey actions. Right-click customization may use the Print panel rather
than duplicating Tekmetric's inline interval menu.

**Why:** Visual parity does not authorize new provider writes or a duplicate
provider-specific menu implementation.

**How to apply:** Preserve location-scoped configuration and final order checks
for both immediate print and panel-based customization.

Treat current-tab Shopmonkey session identifiers as advisory location context,
never as MOS authentication or permission to print.

**Why:** The live order page supplied no usable location through the existing
storage probes. Shared browser storage can also retain other locations, so
selecting an arbitrary cached identity would risk the wrong print settings.

**How to apply:** Keep credentials out of diagnostics and page messages. Resolve
ownership and account access server-side, invalidate stale tab context, and show
a visible unavailable state instead of silently choosing a different location.

Do not treat one minute of provider network inactivity as evidence that the
current tab changed locations.

**Why:** An idle order stopped supplying qualifying requests, causing valid
location identifiers to disappear while the order ID remained present. Server
permission checks around the reported incident succeeded; that did not prevent
the client from discarding context.

**How to apply:** Retain only advisory identifiers in tab memory for a bounded
window no longer than the observed token expiry. Continue checking server
authority, reject navigation and identity changes, and distinguish client context
failures from actual permission denials. Never persist the provider credential.
