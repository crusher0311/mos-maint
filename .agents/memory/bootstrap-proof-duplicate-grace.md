---
name: Bootstrap proof duplicate grace
description: Extension bootstrap proofs are no longer strictly single-use — a small grace budget absorbs same-second duplicate exchanges.
---

The extension side panel/background can fire two bootstrap exchanges of the same provider proof within the same second (across worker restarts / multiple triggers), so strict single-use made the losing twin render "Automatic access could not verify this provider session" to a user who was actually logged in.

**Rule:** the proof claim allows up to 3 exchanges of the same fingerprint within the 90s proof lifetime (extra exchanges log `proofStatus=duplicate_grace`); a hard `replayed` only happens past that budget. Client-side, both background and sidepanel re-check installed auth before surfacing a bootstrap failure.

**Why:** every exchange is still live-verified against Tekmetric, and the rate limiter is fixed-window anyway (single-use was already only per-aligned-window), so the grace does not meaningfully weaken replay resistance — but it removes the false login error.

**How to apply:** don't "tighten" the claim back to limit 1 without solving the duplicate-request race end to end; watch prod for `duplicate_grace` lines instead of paired `verification_needed`/`replayed` lines.
