---
name: AutoFlow bootstrap proof discovery
description: Why AutoFlow extension auto-login stays unsupported — no verifiable current-user proof.
---

Full evidence (endpoints probed, why rejected): docs/autoflow-bootstrap-proof-findings.md.

Rule: AutoFlow keeps the calm `unsupported` bootstrap outcome; never forward
cookies or probe the provider for it. Locked by tests/extension-provider-proof.smoke.ts
(wired via test:extension-provider-proof → test:extension-principal-scope → test:smoke).

**Why:** matched_user/basic bootstrap needs a provider-attested current-user
subject/email + membership from a narrow captured credential. AutoFlow exposes
neither: v3 is cookie-only (forwarding forbidden); v4 renders identity from
server-side Inertia page props with no probeable identity endpoint, and its only
bearer-validating endpoint yields a channel signature, not identity.

**How to apply:** CONFIRMED CLOSED on live logged-in HAR captures of both
versions (2026-08-25): v3 is cookie-only with no narrow credential; v4 uses zero
presence channels and broadcasting/auth returns signature-only. Do not revisit
unless AutoFlow ships a new bearer-verifiable identity API.
