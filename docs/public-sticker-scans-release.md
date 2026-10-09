# Public sticker scans: release handoff

The change permits anonymous GET/HEAD only on `/api/sticker/redirect/{shopId}`
(with an optional trailing slash and query string). Sticker management stays
protected. Shop validation, vehicle-reference resolution, entitlements and signed
report checks are unchanged. No HoverCode targets, images or printed links need
to be changed or regenerated.

## Offline validation

- `npm run test:middleware-sticker-redirect`
- `npm run test:sticker-dynamic`
- `npm run test:middleware-extension-backend-allowlist`
- `npm run typecheck`

The sticker suites use synthetic dependencies and deny external network access.
Do not start the full application against shared production stores to test this.

## After an authorized deployment

Run a single anonymous invalid-shop probe (no cookies, no authorization and no
redirect following):

```sh
curl -q --max-time 20 -i -H 'Cookie:' -H 'Authorization:' \
  https://mos.tools/api/sticker/redirect/0
```

Expected: **400** with `{"error":"Invalid shop ID"}`, not middleware's
**401** with `{"error":"Unauthorized"}`. Shop ID 0 is rejected before database
access or scan logging, making this a non-mutating check. A 401 means the fix
has not reached that request path; do not regenerate QR codes to work around it.

Deployment and the originally reported QR have not been verified by this task.
Obtain the actual failing QR URL and explicit authorization for an end-to-end
real-shop scan: valid scans write scan analytics. Confirm its redirect chain and
destination without retargeting or regenerating any existing HoverCode.
