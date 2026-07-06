---
name: server-only blocks tsx smoke tests
description: Why pure logic must be split out of any module that imports "server-only" to be unit-testable.
---

Any module that starts with `import "server-only"` THROWS when imported under
`tsx` (the smoke-test runner) — the package's default export throws outside a
React Server Component / bundler-server context. So a `*.smoke.ts` test cannot
import such a module, even to test a pure function inside it.

**Why:** `node_modules/server-only/index.js` throws unconditionally under plain
Node/tsx. All `tests/*.smoke.ts` run via `tsx`.

**How to apply:** To unit-test pure logic (matchers, tokenizers, formatters)
that currently lives in a `server-only` file, extract it into a sibling module
WITHOUT the `server-only` marker and WITHOUT db imports, then re-export it from
the server file so consumers keep one import surface. The pure module may still
import other pure helpers and even functions from heavier modules (e.g.
`computeAnchorMiles` from `lib/plan-build/triage`) as long as nothing in that
import chain pulls in `server-only` or calls `getDb()` at module load time —
`triage` imports cleanly under tsx; verify with a quick probe before relying on it.
Example split: `lib/last-performed.ts` (server: loads history) vs
`lib/last-performed-match.ts` (pure: matchLastPerformed, tested by
`tests/last-performed-match.smoke.ts`).
