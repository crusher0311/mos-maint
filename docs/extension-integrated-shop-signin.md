# Integrated-shop extension sign-in investigation

## Confirmed in controlled fixtures (2026-09-30)

The September 30 screenshots show the same configured-shop error for an
AutoFlow account and for Odell Automotive with Shop-Ware connected. Neither
screenshot proves the account's assignment records or primary-provider metadata.
**Live-account confirmation remains pending for both reports.** No production
records, credentials, mappings, or deployments were changed.

### AutoFlow

`app/api/settings/autoflow/route.ts` saves `autoflowDomain` at the shop's top
level. Extension auth already projected it and used it for context matching,
but default provider detection ignored it. With valid credentials and no
resolvable active-tab context, an AutoFlow-only assigned shop therefore returned
403, “A configured shop is required for extension access.”

Default recognition now uses the existing provider-support rules, including
top-level domains, nested domain/subdomain/shop ID, and nonempty learned shop
numbers. The response integration list and AutoFlow SMS identifier also include
these supported shapes. Empty learned-number arrays are not configuration.
Explicit primary providers retain precedence; mixed SMS/AutoFlow shops are not
automatically converted to AutoFlow. A uniquely matching advisory tab can still
scope the session to a supported integration, as before.

Extension identity eligibility is not an upstream API credential test: AutoFlow
settings GET calls domain + key configured, while the DVI client needs domain +
key + password. This patch preserves the extension's identifier-based eligibility
and does not fetch, forward, or validate AutoFlow passwords/cookies.

### Shop-Ware / Odell

`app/api/settings/shopware/route.ts` persists numeric `shopware.tenantId` and
`shopware.swShopId`, optionally `tenantSubdomain`. Its GET reports configured
when tenantId is present. The settings UI fetches this endpoint independently
of extension authentication.

A fixture matching that normal save shape already succeeds without this fix.
Ordinary `shop-ware` and `shop_ware` primary-provider aliases already work.
Supported subdomain-only legacy records were omitted by default detection;
they now work. Surrounding whitespace on primary-provider labels is normalized.
Neither edge case is established as Odell's live configuration.

A connected Shop-Ware fixture with stale explicit `integrationProvider:
"tekmetric"` and no Tekmetric identifiers reproduces the rejection even if
`smsProvider` is `"shopware"`. Generic integration selection writes smsProvider,
not integrationProvider; Shop-Ware connect does not overwrite integrationProvider.
This conflict is intentionally **not silently remapped**: a primary-provider
change needs operator confirmation, and the live record has not been inspected.
Unknown explicit provider labels also remain rejected.

Auth collects assignments from same-email user documents (`shopId` plus
`shopIds`) and queries both numeric/string shop-ID variants. Fixtures cover these
paths, missing shop documents, and shopIds-only accounts. The settings page uses
the active web-session shop instead, so a visible connection alone does not prove
that the manually signed-in extension account is assigned to that shop.
Enterprise expansion in legacy token validation is a separate path, unchanged.

The extension's manual request in `mos-tools-extension/background.js` forwards
active-tab provider and SMS shop context. That context remains advisory; stale,
ambiguous, or unassigned tab context cannot grant access or block an otherwise
eligible credentialed login. An explicit unassigned MOS shop request is still
403. Invalid passwords are still 401. All issued sessions remain server-scoped
and verified; no configured assigned shop still means no session.

## Offline verification

Run with mocked stores, without booting the application against shared databases:

```sh
npx tsx tests/extension-auth-integrated-shops.smoke.ts
npx tsx tests/extension-auth-context-advisory.smoke.ts
npx tsx tests/extension-auth-enterprise-access.smoke.ts
npx tsx tests/extension-auth-no-plaintext.smoke.ts
npx tsx tests/extension-login-code.smoke.ts
npm run typecheck
```

The integrated fixtures enforce Mongo query filtering and projection, and assert
both session issuance and response scope. Shop-Ware session SMS identity retains
the existing tenant-ID convention; swShopId is not substituted for tenantId.

## Short off-hours verification checklist

After a separately authorized release:

1. Record extension version, API hostname, time, and active tab's provider.
   Do not copy passwords, sign-in codes, authorization headers, or session tokens.
2. Confirm the intended MOS shop ID and the extension account's assigned shop IDs
   through authorized admin tooling. Do not infer identity from the screenshot.
3. Check only nonsecret configuration: AutoFlow domain/nested identifiers or
   Shop-Ware tenant/shop IDs, plus integrationProvider and smsProvider. If explicit
   metadata conflicts, stop and obtain operator approval rather than remapping.
4. Manually sign in first with no provider-tab context, then with the expected
   provider tab, then stale/unresolvable context. Confirm success and the correct
   assigned MOS shop/provider scope, not merely a returned token.
5. For mixed-provider shops, confirm default login preserves the configured
   primary and a matching AutoFlow tab retains existing context-scoping behavior.
   Record any remaining error and its time without capturing credentials.