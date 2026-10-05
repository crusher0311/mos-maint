---
name: Explicit Tekmetric location switching
description: Access and rollout constraints for password-authenticated sticker scope exchanges.
---
Use the matched active account's explicit assignments for modern location exchanges, not a union of same-email documents or enterprise membership. Keep the saved explicit identity unchanged; derive operation-local scopes bounded by, and revoked with, the original login.

**Why:** Duplicate user documents may have different passwords. Enterprise linkage alone does not authorize an advisor. Old session rows do not distinguish password login from verified provider bootstrap, so safely enabling cross-location exchanges requires a one-time explicit sign-in after upgrading. Same-shop use must not require new switching authority: reuse the original credential and expiry only after canonical identity and current direct access are proven; unbound legacy scope needs a single directly assigned primary shop and known original expiry.

**How to apply:** Apply the session provenance migration before server rollout. Never infer eligibility from the extension's local auth-source label. Keep print context and settings operation-local; fail closed on canonical mapping conflicts. See `docs/tekmetric-location-switching.md` for bounded read-only findings and operator verification.

The worker must attach the originating tab identity when forwarding content-script context into the side panel; content-script context alone does not identify its tab.

**Why:** Tests that hand a tab ID directly to printing miss the real Customize → panel transition. Losing that identity safely blocks printing but makes the user flow unusable.

**How to apply:** Exercise panel opening, settings loading, generation and final print routing together. Display settings errors and recovery instructions, rather than leaving a disabled print button without explanation.
