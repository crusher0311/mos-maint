---
name: Extension bootstrap outcomes & advisory login context
description: Bootstrap "can't use it" vs "verification failed" outcome split; tab context must never gate manual login.
---

Rule 1: In the extension auth route, tab-supplied provider/smsShopId context is ADVISORY scoping only. Valid credentials + at least one configured assigned shop must always sign in; the only hard 403 is an explicit requestedShopId the user isn't assigned to.
**Why:** The 2026-08 bootstrap rollout forwarded tab context into manual login; any unresolvable/ambiguous context (brand-new shop, stale tab, unassigned shop) 403'd logins with valid credentials (Martin's Tire & Service incident).
**How to apply:** Context-resolution failures log an advisory-miss and fall back to the user's default/first configured shop; never echo an unmatched smsShopId into the session.

Rule 2: Provider-proof status distinguishes `unavailable` (shop lookup miss, not allowlisted, kill switch) from `invalid`/`expired`/`replayed` (real verification failures). `unavailable` and `unsupported` map to 200 + calm "sign in" sidepanel copy; only genuine proof failures map to 401 `verification_needed`.
**Why:** A brand-new shop is a normal state; alarming "could not verify" copy hid the real situation and stuck around the login form.

Rule 3: Sidepanel manual sign-in must clear bootstrap status (`showBootstrapOutcome(null)`) at submit so a login failure shows the real auth error, not stale bootstrap copy.

Covered by smoke tests: extension-auth-context-advisory, extension-bootstrap-unavailable (chained into test:smoke via test:extension-principal-scope).
