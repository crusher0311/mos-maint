---
name: Extension session authority
description: Security boundary for tiered extension sessions and browser-direct provider writes.
---

Treat the extension role label as presentation only. Mutation and administration authority comes from the server-recomputed assurance/capability principal, with every first-class session constrained to its signed shop and on-page provider context.

**Why:** A Basic principal intentionally looks like a normal `user`, and provider pages can expose mutation helpers in the browser. UI hiding, local claim parsing, or requesting a grant without consuming it does not create a security boundary.

**How to apply:** Classify every extension-backed method centrally. For browser-direct provider writes, issue a short-lived bound grant and cryptographically consume it exactly once at the actual mutation sink; never expose the long-lived extension bearer to the provider page. Keep legacy token compatibility on a fixed, non-renewing expiry.