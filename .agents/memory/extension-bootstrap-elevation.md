---
name: Extension bootstrap auto-elevation
description: Identity-trust rules for bootstrap email-match elevation and why it can silently never fire
---
Auto-elevation (matched_user) requires: verified proof, active MOS user assigned to the resolved shop, single unambiguous identity. Trust rules: the provider profile email counts as verified unless the provider explicitly negates it (Tekmetric has NO emailVerified-style flag — requiring an affirmative flag silently disabled matching fleet-wide). On first email-match elevation the provider subject is PINNED to the MOS user (providerIdentities); thereafter only that subject elevates and email fallback is off for that user — this is the guard against an insider re-pointing their provider profile email at an admin. Subjects are provider-global, so a pinned user still elevates at other assigned tenants.

**Why:** email match alone proves the session's email, not keyboard ownership or email ownership; pinning closes the email-repoint elevation path while keeping zero-friction login.

**How to apply:** never log raw provider emails (hash correlation id) or unsanitized caller ids; symptom of a dead matcher is zero matched_user outcomes fleet-wide while local match probes succeed. Extension reuses a valid basic session for its full TTL — revoke the shop's basic extension_sessions to force re-bootstrap after access changes.
