---
name: AppFueled native notification contract
description: Accepted connection-ID authentication and separation from deployment authorization.
---

QA's AppFueled tables use the shared production Supabase database. Any environment that must read the same encrypted connection records must use the same dedicated encryption key; do not independently generate a replacement during promotion.

**Why:** The QA deployment target was verified to share the production database, while its encryption key was provisioned only on QA. Different keys would make shared credentials unreadable.

**How to apply:** Before enabling native AppFueled connections on another environment, securely align its key with QA under explicit authorization. Never log the key or overwrite an existing key without checking compatibility.

AppFueled supplies per-store API key, API secret and connection ID through a secure channel. The user explicitly accepts the connection ID in the native notification as its authentication mechanism; `mos_shop_id` is MOS-issued, not an upstream provider ID.

**Why:** The partner confirmed this contract. Requiring additional signatures, delivery IDs, partner-key headers or provider enrollment would prevent their native notifications from working.

**How to apply:** Preserve the native contract without reopening security negotiations. Keep legacy partner-key endpoints independently authenticated. Code implementation does not authorize deployment, shared-database mutations, live credential provisioning or real webhook submissions.
