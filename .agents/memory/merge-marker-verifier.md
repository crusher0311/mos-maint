---
name: Merge marker verification
description: Decorative equals-sign comment dividers can block conflict completion.
---
Conflict completion can reject comment dividers containing seven consecutive
equals signs even when no actual Git conflict markers remain.

**Why:** A Protractor adapter merge was rejected despite a clean `git diff
--check` and no line-start conflict markers; its decorative comment separators
were matched by the verifier.

**How to apply:** If verification disagrees with Git, search for marker substrings
anywhere in the conflicted file. Replace decorative equals-sign dividers with
hyphens, preserving the code and actual merge decisions.
