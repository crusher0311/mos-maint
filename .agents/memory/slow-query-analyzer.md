---
name: Slow-query analyzer seams
description: Durable constraints when touching Mongo/PG slow-op capture
---

- postgres-js queries execute lazily on first `.then` and builder methods (`.simple()`, `.values()`) return `this` — instrument by patching `.then` in place on the Query instance; a Proxy over the query loses the wrapper. **Why:** learned building the analyzer; a Proxy-based attempt silently dropped captures on chained builders.
- Modules reachable from `src/instrumentation.ts` (anything lib/mongo.ts imports) must not import bare node `"crypto"` — webpack bundling fails the whole dev build. Use pure-JS hashing for non-security keys.
- Any self-observing capture pipeline needs a recursion guard (drop captures targeting its own storage table) or its flush generates captures forever.
- Sanitizers that will face reviewer/security scrutiny need a real lexer, not regexes: PG `E'…'` backslash escapes, `''` doubling, dollar-quote tags, and nested block comments all break regex redaction; on uncertain parse, redact the remainder rather than retain it.
- Mongo `monitorCommands` must be set at client creation, so the kill switch only removes event overhead after a process restart.
