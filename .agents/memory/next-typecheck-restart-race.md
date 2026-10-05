---
name: Next typecheck restart race
description: Avoid concurrent dev cache cleanup and TypeScript checking.
---

Run typechecking after the Next development workflow has finished restarting,
not in parallel with that restart.

**Why:** The predev cache guard can remove generated `.next/types` files after
TypeScript has enumerated them. This produces TS6053 missing-file errors for
unchanged routes even when the application and source types are valid.

**How to apply:** Wait for the development server to be ready, then run the
typecheck. Do not alter route code or tsconfig to mask this transient race.