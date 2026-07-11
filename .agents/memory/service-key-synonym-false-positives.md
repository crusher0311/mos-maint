---
name: Service-key synonym false positives
description: Substring-based SERVICE_KEYS matching silently cross-matches; corpus-check every new synonym before adding.
---

The service-key matchers use lowercase substring `.includes` over synonym lists, so
new synonyms can silently cross-match unrelated phrases. Real corpus-verified
examples: a bare `"oil"` fallback matched "Ignition **coil**(s) replaced" (falsely
resetting the oil clock); `"air filter replace"` under engine_air matched "**Cabin**
air filter replaced"; battery synonyms matched "keyless **remote** battery replaced".
Guards for these now live next to the matchers.

**Why:** performed-verb phrases that resolve to a key ANCHOR interval clocks — a
false match silently erases a due service.

**How to apply:** before adding any synonym, grep the CARFAX corpus for collisions —
`scripts/probe-carfax-phrase-corpus.ts` (read-only, probe- prefix passes the
direct-db guard) re-measures matched/unmatched rates against cached carfax_reports
and writes docs/carfax-phrase-corpus.md. Also note CARFAX's standardized vocabulary
uses "(s)" spellings ("Tire(s) replaced") and "X/Y" slash compounds that defeat
plain `\btires?\s` style regexes and plural substrings.
