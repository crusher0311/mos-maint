---
name: Tekmetric posted ROs reject job adds
description: Any POST /api/shop/{id}/job on a posted (closed) RO 400s; how to diagnose extension add failures and probe the page API safely.
---

# Tekmetric posted ROs reject job adds

Tekmetric's internal page API rejects job creation on posted ROs with
`400 {"details":{"repairOrderId":"Jobs can only be added to open repair orders..."}}`.
GET `/repair-order/{id}` still returns 200 on posted ROs, so a successful
fetch-ro followed by a 400 post-job is the signature of this case — not a
payload bug.

**Why:** live-verified 2026-07-11: the identical payload (even with $0 parts,
empty brand/partNumber) succeeds on a Work-In-Progress RO and 400s on a
Posted RO. The extension gate (background.js createTekmetricJob) checks
`repairOrderStatus.name === 'Posted'` first; `postedDate` only as fallback
because it can linger after an RO is reopened.

**How to apply / diagnose:**
- Extension-side Tekmetric write failures are visible in Mongo
  `tekmetric_endpoint_reports` (label like `createTekmetricJob.post-job`,
  status, isError, reportedByUser) — but NOT the response body.
- To capture a page-API error body, replicate the call server-side with the
  shop's stored token: `shops.tekmetric.xAuthToken` (relayed by the extension
  every 30 min, ~24h lifetime), header `x-auth-token`, base
  `https://shop.tekmetric.com/api`.
- Job delete (cleanup) endpoint shape: `DELETE /api/shop/{shopId}/jobs?jobIds={jobId}`
  (singular `/job/{id}` 404s).
