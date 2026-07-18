---
name: Hardcoded version pins in smoke tests block prod deploys
description: Prebuild smoke tests that assert an exact manifest minor version fail every future bump and block ALL Render prod deploys.
---

# Smoke-test version pins block deploys

A "manifest version is at least X" assertion written as `maj===1 && min===27 && patch>=11` fails as soon as the extension bumps to 1.28.x — and because `test:smoke` runs in Render's prebuild, one such assertion blocks EVERY production deploy of main (observed: main build_failed 2026-07-13, prod stuck on an older commit while fixes queued behind it).

**Why:** version floors must be a true semver-minimum comparison, not equality on the minor segment.

**How to apply:** when adding a version floor to any smoke test, compare segment-by-segment (>= semantics). When prod "isn't picking up a fix," check the latest Render deploy status first — a build_failed on main means nothing after it shipped, regardless of auto-deploy being on. Other tests in the `test:smoke` chain may still carry the same pattern (audit pending).
