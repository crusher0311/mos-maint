---
name: Sidepanel plan cache goes stale after adds
description: Extension side panel's 5-min SWR plan cache repaints the pre-add plan after the post-add page reload; any RO mutation must expire/patch it.
---

The extension side panel keeps a 5-minute stale-while-revalidate plan cache
(`planCache`, keyed `shopId::roId`). A fresh entry (<TTL) short-circuits the
network entirely. The Tekmetric add flow reloads the SMS page ~1.5s after a
successful add; the content script re-sends context, `loadPlan()` runs, and
the still-fresh cache repaints the PRE-add plan — so "On Estimate" badges
never appear for jobs just added (`onCurrentRO` was computed server-side
before the add). The server is NOT at fault: it fetches the RO's jobs fresh
on every plan request.

**Why:** Seen live on RO #26362 (shop 524): control arm + wheel alignment
were on the estimate (partner API confirmed) but cards kept "+ Add"; prod
logs showed the last plan request predated the adds and no request afterward.

**How to apply:** Any extension flow that mutates the current RO (add job,
canned add, add-all-declined, job builder) must call
`markServiceOnEstimate(jobName, snapshottedCacheKey)` — it optimistically
flips matching cards, sets `entry.ts = 0` (expire, don't delete → instant
repaint + quiet server revalidation), and re-renders. New RO-mutating flows
must do the same or the stale-cache bug returns. Diagnosis tip: "badge
missing" reports need the request TIMELINE from prod logs — the server may
have been right at the time it was asked.
