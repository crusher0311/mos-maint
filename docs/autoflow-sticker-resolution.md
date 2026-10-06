# AutoFlow sticker resolution

## Evidence and scope

The supplied screenshot reports the sticker API's explicit unlinked-shop
message and a bottom-right button. It contains no usable shop name, AutoFlow
URL, request, or session identity. It is not evidence of a printer failure.

The offline fixture reproduces a session-dependent mismatch: a shop with
`autoflowDomain` plus existing `autoflow.shopNumbers` resolves through legacy
compatibility lookup, but canonical-only lookup rejects its numeric alias.
First-class AutoFlow sticker sessions previously selected that canonical-only
branch. This establishes a code defect, not the affected customer's diagnosis.

The local Tekmetric location-switching release notes identify 1.35.4 with that
Tekmetric work. The AutoFlow request path is separate; neither those notes nor
the screenshot establish that 1.35.4 caused this incident. No published package,
release timing, or affected request has been correlated here.

## Resolution contracts

- Interactive AutoFlow sticker GET (settings) and POST (generation) use the
  same read-only lookup, for both legacy and first-class sessions.
- Global canonical ownership wins over aliases, including inaccessible owners.
  Existing numeric aliases are accepted only when uniquely owned.
- Unknown identities, nonnumeric alias-only identities, duplicate owners,
  provider mismatches, and shops outside session/account scope remain blocked.
- The exact server-managed partner resolver is unchanged: canonical fields only,
  no alias discovery, learning, or telemetry writes.
- Printing creates no new AutoFlow associations. Other compatibility consumers
  retain their existing behavior; this is not a broad auth migration.

## Button and request trace

The AutoFlow adapter reads the v3 shop subdomain or the v4 `/shop/<number>` path
and sets `provider: autoflow`. Both inline placement and the bottom-right
fallback call `createPrintButton`. The fallback is selected only when no known
header, toolbar, or print anchor is found (right 20px, bottom 80px).

Left click sends `PRINT_STICKER_IMMEDIATE` with freshly detected context.
Right-click interval selection sends that same action with interval overrides;
Customize sends `OPEN_STICKER_PANEL`. Settings GET uses the page shopId/provider,
and generation POST uses smsShopId/provider. Both API methods use the corrected
resolver and independently enforce the principal scope. Tekmetric's
switch-location exchange is not applied to AutoFlow. Placement was not changed.

## Regression verification

`tests/autoflow-sticker-resolution.smoke.ts` runs the actual lookup and sticker
handler bodies with fake Mongo, real principal scope checks, and stubbed
rendering/external services. It covers canonical and string/numeric aliases,
legacy/first-class settings, default/custom generation and branding, global
ownership conflicts, inaccessible owners, unknown IDs, cross-provider
collisions, principal mismatch, temporary DB failure, and exact partner
non-mutation. This verifies the server path, not physical printer output.

Supporting checks:

- `tests/extension-shop-lookup.smoke.ts`
- `tests/sticker-location-resolver.smoke.ts`
- `tests/autoflow-v4-context.smoke.ts`
- `tests/extension-sticker-messages.smoke.ts`
- `tests/sticker-location-session.smoke.ts`
- `tests/extension-principal-scope.smoke.ts`

No production connection, mapping edit, deployment, credential reset, or Chrome
Web Store publication was performed. An ordinary app preview was not booted:
this isolated workspace can reach shared production stores during startup.
The signed-in UI and a real AutoFlow page were not visually verified.

## Affected-shop verification checklist (operator)

1. Obtain the shop name, full AutoFlow page URL, incident time, installed
   extension version, and whether the failing action was immediate or customized.
   Do not copy tokens, cookies, credentials, or customer details into evidence.
2. Read-only: correlate the page subdomain/number with global canonical fields
   and numeric aliases, including owners outside the user's scope. Check session
   provider and authorized MOS shop using redacted request evidence.
3. If the numeric mapping is absent or ambiguous, this change deliberately does
   not repair it. A separately authorized operator must verify ownership and
   use the existing mapping administration process. Never infer ownership from
   the user's sole accessible shop.
4. After separately approved deployment, test v3 domain and v4 number with the
   affected account: settings, immediate print, interval override, and Customize.
   Confirm logo, phone, service interval, destination, and originating shop.
5. Confirm unlinked/forbidden/conflicting identities stay blocked (404/403/409)
   and transient failures show retry guidance (503). Record redacted request
   time/status and session type, not credentials. Verify both inline/floating
   buttons where present; do not treat placement alone as a mapping fault.
