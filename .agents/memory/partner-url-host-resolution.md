---
name: Partner absolute URL host resolution
description: Any absolute URL handed to partners (reportUrl, serviceIconUrl, future hosted assets) must resolve its host via the shared lib/app-host.ts, not NEXT_PUBLIC_BASE_URL.
---

# Partner absolute URL host resolution

All absolute URLs we hand to external/partner consumers must derive their host
from the single shared resolver in `lib/app-host.ts` (`resolveAppHost()` /
`getAppBaseUrl()`), which encodes the prod/qa/dev precedence
(NEXT_PUBLIC_APP_URL → RENDER_EXTERNAL_URL `mos-tools`→`mos.tools` /
`mos-tools-qa`→`qa.mos.tools` → NEXT_PUBLIC_BASE_URL → REPLIT_DEV_DOMAIN →
localhost).

**Why:** the partner VHI `reportUrl` already uses this precedence. A second URL
built from a different env var (e.g. `NEXT_PUBLIC_BASE_URL` alone) can silently
resolve to a different domain in prod/qa than the report link, so partners get
inconsistent hosts for the same response. Keeping one resolver guarantees every
URL in a partner payload is on the same trusted domain.

**How to apply:** when adding any new absolute URL to a partner/external
response, import `getAppBaseUrl` from `@/lib/app-host` rather than reading an env
var inline. `lib/app-host.ts` is intentionally pure (env-only, no
crypto/fs/React) so it is safe to import from modules that also get bundled
client-side (e.g. `lib/service-icons.ts`). `getServiceIconUrl` is server-only in
practice (called from `formatVhiItem` and the route's `ensureItemIconSvg`), so
its reads of non-`NEXT_PUBLIC_` env vars are fine.
