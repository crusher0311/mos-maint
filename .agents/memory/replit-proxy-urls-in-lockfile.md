---
name: Replit proxy URLs poison package-lock
description: npm installs inside Replit write package-firewall.replit.local tarball URLs into package-lock.json, which kills the Render build with ENOTFOUND
---

Installing an npm package inside the Replit workspace can record the
resolved tarball URL as `http://package-firewall.replit.local/npm/...`
in `package-lock.json`. That host only resolves inside Replit — on
Render, `npm ci` dies at install time with `getaddrinfo ENOTFOUND
package-firewall.replit.local` **before** prebuild even runs, so the
lockfile-sync guard alone never got a chance to catch it.

**Why:** Replit routes npm through an internal package-firewall proxy;
`npm view <pkg> dist.tarball` inside Replit also shows the proxy URL.
The proxy serves the identical tarball, so the recorded `integrity`
hash matches the public registry.

**How to apply:**
- Fix = rewrite the host to `https://registry.npmjs.org/...` in the
  lockfile (keep the integrity hash — it's the same file). Do NOT run
  `npm install --package-lock-only` inside Replit to fix it; that can
  re-introduce proxy URLs.
- `scripts/check-lockfile-sync.cjs` now fails on any `.replit.local`
  URL in the lockfile (runs in prebuild/test:smoke), so task-agent
  merges that add packages get caught locally.
- After ANY dependency change, grep the lockfile for `replit.local`
  before Brandon pushes.
