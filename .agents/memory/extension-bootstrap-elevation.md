---
name: Extension bootstrap auto-elevation
description: Why bootstrap email-match elevation (matched_user) can silently never fire and how to diagnose
---
Bootstrap auto-elevation (verified session with the matched MOS user's permissions) requires ALL of: proof verified, MOS user active + assigned to the resolved mosShopId (shopIds strings/ints both OK), and a usable provider identity — subject mapping OR verified email.

**Why:** it silently never fired fleet-wide because the email extractor required an affirmative emailVerified-style flag that Tekmetric's /api/profile simply doesn't have; every proof carried subject-only, and subject matching needs pre-existing provider identity mappings nobody has. Symptom: outcome=basic everywhere, zero matched_user in logs, while local match probes succeed.

**How to apply:** treat provider login email as verified unless explicitly negated. Diagnose with masked `employee=`/`subject=` on basic outcomes. Also: extension reuses a valid basic session for its full 8h TTL — after granting shop access, revoke the shop's basic extension_sessions rows (prod PG) to force re-bootstrap. Sidepanel can render a failure even when a twin request succeeded (proof single-use ⇒ duplicate request gets `replayed`).
