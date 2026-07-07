---
name: Tekmetric "add canned job" perceived slowness
description: Why adding a canned job on Tekmetric feels slow — it's the post-success full page reload, not the server or upstream write.
---

# Tekmetric add-canned-job slowness = the post-success page reload

**Symptom (operator):** "Adding canned jobs takes an extended amount of time," specifically *after picking a job and hitting Add*, for **Tekmetric** users.

**The write itself is fast — proven, not assumed:**
- MOS route (`app/api/tekmetric/apply-canned-job`) reduces to a SINGLE upstream POST because the extension passes `repairOrderId` directly (skips VIN lookup). The cached-RO Mongo lookup is a 2ms IXSCAN (`tekmetric_work_orders`, index `shopId_1_vin_1_completedDate_-1`).
- The Tekmetric `POST /repair-orders/{id}/canned-jobs` latency (measured from `api_usage`, provider=tekmetric, method=POST, in known-active windows): **avg ~486ms, p50 ~528ms, p90 ~852ms, max ~852ms, retry=0**. Occasional single 429 that fast-fails (~86ms) then succeeds. So NOT rate-limiter queueing, NOT upstream slowness, NOT the server route.
- Feature is low-volume: ~23 adds/7d, ~49 tekmetric adds/30d (`canned_job_applications`). Don't panic if a 24h `api_usage` window shows 0 POSTs — just quiet, query a window with known completions.

**Actual cause = client-side, in the extension:** on success the sidepanel fires `notifyPageJobCreated(["*://*.tekmetric.com/*"], ...)` → the Tekmetric content script's `JOB_CREATED` handler (`mos-tools-extension/adapters/tekmetric-content.js`) does `setTimeout(() => window.location.reload(), 1500)` — a **1.5s delay + a full Tekmetric SPA cold reload** (several seconds, page unusable). Adding several jobs in a row triggers a reload per add, compounding the pain.

**Why:** Tekmetric's own SPA has no idea MOS added a job via API, so a full reload is the blunt way to make the new job appear. That reload — not the API call — is the "extended time."

**How to apply:** For any "add is slow" report on a Tekmetric *write* that ends in `JOB_CREATED → reload`, measure the upstream POST from `api_usage` first (it's usually sub-second) and look at the content-script reload, not the server. Same reload pattern exists for Protractor/AutoFlow JOB_CREATED and for PREFILL_DVI / ENHANCE_FINDINGS handlers. Any fix is an **extension change → manual CWS publish (operator-gated, never auto-publish)**.
