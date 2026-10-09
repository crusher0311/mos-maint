---
name: AppFueled native notification contract
description: Accepted connection-ID authentication and separation from deployment authorization.
---

AppFueled supplies per-store API key, API secret and connection ID through a secure channel. The user explicitly accepts the connection ID in the native notification as its authentication mechanism; `mos_shop_id` is MOS-issued, not an upstream provider ID.

**Why:** The partner confirmed this contract. Requiring additional signatures, delivery IDs, partner-key headers or provider enrollment would prevent their native notifications from working.

**How to apply:** Preserve the native contract without reopening security negotiations. Keep legacy partner-key endpoints independently authenticated. Code implementation does not authorize deployment, shared-database mutations, live credential provisioning or real webhook submissions.
