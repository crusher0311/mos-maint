---
name: Settings route shop scoping
description: Why some Settings → Integrations provider cards showed the wrong shop for platform admins
---

# Settings/Integrations provider cards must scope to the SWITCHED shop, not the home shop

The platform-admin shop switcher updates `session.shopId`. Any settings/integrations
API route MUST resolve the shop via `getSession()` (returns `session.shopId`), NOT by
reading `user.shopId` (the admin's HOME shop).

**Why:** Three routes (`tekmetric`, `shopware`, `shopmonkey`) had a private
`getUserShopId()` that looked up the Mongo session then returned `user.shopId`,
ignoring the switch. The other surfaces (`carfax`, `autoflow`, `protractor`,
`integrations`, `data-status`) use `getSession()`. Result when an admin viewed another
shop: the provider card reflected the admin's own shop (e.g. "not connected") while the
Data Status panel — which uses the switched shop — correctly showed that shop's data.
Classic "has data but says not connected" mismatch.

**How to apply:** When adding/auditing a settings route, resolve shop via `getSession()`
and keep it consistent across GET/POST/DELETE. `getSession()` reads only the
`session_token` cookie (the legacy `sid` fallback is dead) and already handles the
PG-canonical identity branch + dev auto-login, so it's the canonical resolver.

Companion data gotcha: `smsProvider` (the Shop Management radio's stored preference) can
drift from the real connection. When you disconnect/relabel a shop's integration, also
fix `smsProvider` (e.g. to `"standalone"`) or the radio keeps showing the old provider
even after the connection is gone.
