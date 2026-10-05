---
name: AppFueled test traffic runs on QA
description: AppFueled test-key VHI requests may target QA, so required signing config must be aligned across active web services
---
AppFueled requests with the test partner identity (`appfueled---test`) hit the QA service/domain, not the main production service. Required VHI response configuration such as `REPORT_SHARE_SECRET` must therefore exist on QA as well as production. A production-only configuration check can look healthy while all test-partner requests still return 500s.

**Why:** this caused repeated partner VHI 500s after the production fix was already live; QA was serving an older successful deploy because its newer deploy failed the required-secret startup gate.

**How to apply:** when AppFueled reports an error, identify the partner identity and search both main and QA logs. Keep the report signing secret identical between those two services so links verify consistently; after changing it, redeploy/restart and prove the running process with a signed-token request.

QA branch freshness must be checked independently of workspace source. A successful live deployment can still implement an older contract when the remote branch never received the compatibility work.

**Why:** on 2026-10-05 the exact QA CARFAX allowlist error matched the deployed revision, while workspace validation already accepted `live_api`; there was no newer failed deployment to fix.

**How to apply:** compare Render's live commit with both the remote QA branch and intended source before restarting or changing validation. Check both hostname aliases through domain metadata, not by assuming separate applications.

For AppFueled `live_api` CARFAX requests, the operator clarified that `smsShopId` is the **MOS shop ID**, not an AppFueled ID or the upstream provider's ID.

**Why:** searching upstream identifiers for the submitted number falsely suggested the intended shop could not be identified.

**How to apply:** retain explicit operator authorization of the target MOS shop; verify its configured upstream identity separately. Never ask the partner to substitute a canonical provider for `live_api`.
