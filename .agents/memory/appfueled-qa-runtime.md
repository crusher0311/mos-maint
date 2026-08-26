---
name: AppFueled test traffic runs on QA
description: AppFueled test-key VHI requests may target QA, so required signing config must be aligned across active web services
---
AppFueled requests with the test partner identity (`appfueled---test`) hit the QA service/domain, not the main production service. Required VHI response configuration such as `REPORT_SHARE_SECRET` must therefore exist on QA as well as production. A production-only configuration check can look healthy while all test-partner requests still return 500s.

**Why:** this caused repeated partner VHI 500s after the production fix was already live; QA was serving an older successful deploy because its newer deploy failed the required-secret startup gate.

**How to apply:** when AppFueled reports an error, identify the partner identity and search both main and QA logs. Keep the report signing secret identical between those two services so links verify consistently; after changing it, redeploy/restart and prove the running process with a signed-token request.
