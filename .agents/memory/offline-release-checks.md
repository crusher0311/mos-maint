---
name: Offline release checks
description: Interpreting elapsed-time failures and non-exiting smoke tests during release verification.
---

Treat Render compilation memory separately from the running application's plan.

**Why:** The combined application compiled locally but exhausted a roughly 2 GB V8 heap on Render after regression tests passed; the large web runtime plan did not prevent that build-process limit.

**How to apply:** Check the failing stage and heap diagnostics before recommending a paid upgrade. A build-command-only heap allowance keeps runtime settings unchanged. Use one lockfile install and one full build connected with `&&`, not a semicolon chain that repeats builds and can mask an earlier failure.

Check Render service events when a build log ends silently.

**Why:** After increasing the Node heap, compilation succeeded but page generation
was killed at the builder's aggregate 8 GiB limit. Only the Render build/deploy
event exposed the OOM termination; the text log stopped at zero generated pages.
Increasing each process's heap does not bound all parallel workers' memory.

**How to apply:** Read the event's failure reason and memory limit before retrying.
Bound build-time worker concurrency before increasing costs; distinguish a V8
heap error from a container-wide OOM. Filter logs to build output and avoid
dumping runtime request labels, which can contain authentication query values.

Use one combined preload entry point when Next production workers inherit offline guards.

**Why:** Next 15 worker spawning combined repeated NODE_OPTIONS `--require` paths into a single nonexistent filename after compilation succeeded.

**How to apply:** Have one absolute-path preload require both network denial and the server-only test shim; retain credential-free subprocess environments. Do not remove safeguards to get the build through.

Use absolute paths for offline NODE_OPTIONS preloads in release checkouts.

**Why:** Route-entrypoint tests spawn Node in temporary fixture directories.
Relative deny-network/server-only preload paths then fail before the authorization
scanner runs, making the fixture falsely report a missing authorization guard.

**How to apply:** Keep the network guard enabled, but anchor preload paths to the
release checkout. Do not change application authorization or weaken the test to
resolve this harness failure.

Managed standalone artifact previews can fail after an otherwise successful
root post-merge setup because their dependency graphs are independent. Verify
each artifact's installation and build separately from the main application.

**Why:** Root setup reported success while both managed previews lacked Vite.
A working development preview also did not establish that its standalone
production bundle could complete.

**How to apply:** Keep setup scoped to locked artifact dependencies, wait for
Next cache cleanup before typechecking, and report an unfinished artifact build
separately rather than conflating it with the production application's tests.

A smoke test's success message is not proof that its process exits cleanly. Keep an outer timeout and verify the process exit, especially for tests importing provider clients with timers.

**Why:** A JWT admission test finished its assertions but remained alive until the release command timed out, preventing later checks from running.

Short real-time deadlines in local relay tests can expire before the intended dispatch stage on a busy workspace. Distinguish a scheduling-dependent assertion failure from a changed production deadline policy.

**Why:** Under workspace load, a queued-expiry test received an ingress-expiry response instead, and an active-response test expired before its upstream saw a request.

**How to apply:** Inspect the failing stage and test timing. Keep network isolation and credentials removed. Repair test coordination/cleanup rather than relaxing production admission or deadline enforcement; never report an assertion banner alone as a completed suite.

Extension DOM tests with mocked successful background replies do not validate the
real message handler.

**Why:** The floating-launcher regression passed mocked UI coverage while the
shared settings handler rejected successful responses. Its separate handler
test also had a stale extraction delimiter.

**How to apply:** Exercise both the real handler and browser lifecycle before
packaging. Assert source-extraction boundaries explicitly; don't weaken hidden
preferences to compensate for a broken settings transport.

Browser reload tests must await intercepted POST completion separately from the
visible warning before navigating.

**Why:** Concurrent status discovery can display a persisted target warning
before the intercepted POST finishes inspecting storage. Reloading at that point
destroys its browser execution context and masks the result with a target-closed
error.

**How to apply:** Coordinate reload with an explicit interception-completion
promise rather than sleeps or the warning text alone.

Isolated release worktrees sharing workspace node_modules can fail native canvas
loading on missing Nix libraries even when Render's build environment passes.

**Why:** The full smoke suite stopped on missing libuuid.so.1 locally; Render
subsequently completed the full build with the same release source.

**How to apply:** Separate environment failures from assertion failures. Preserve
network isolation, do not weaken tests, and require Render's successful build and
live commit verification before reporting a release as deployed.

Do not force `NODE_ENV=production` around the entire `npm run build` lifecycle.
Leave it unset for prebuild tests; Next selects production mode for compilation.
Allow loopback in the offline egress guard when running the tsx CLI.

**Why:** React's production package rejects `act()` in the prebuild UI tests,
and blocking local sockets prevents tsx's own IPC from starting. Both can
falsely block an otherwise valid release before compilation.

**How to apply:** Keep credentials removed and external egress denied, but set
`PROTRACTOR_OFFLINE_ALLOW_LOOPBACK=true` and leave `NODE_ENV` unset when running
the complete npm build lifecycle in an isolated checkout.

Credential-free build environments must retain the workspace's native-library
search paths.

**Why:** Canvas loaded in the ordinary workspace process but failed on
`libuuid.so.1` under `env -i`; the library was not actually missing from the
workspace. Clearing loader configuration caused a false dependency failure.

Browser fixture runners may request a newer Playwright browser than the cached
Chromium installation. A missing executable is not evidence that no browser is
installed; existing Puppeteer-managed Chromium may be usable with an explicit
executable path and its missing native-library directories.

The shell's `ldd` can report no missing libraries while cached Chromium still
fails on an X11 library. Include the narrow directories for the browser's
direct X11 dependencies as well as libraries reported missing by `ldd`.

**Why:** The shell loader resolved X11 through its own runtime paths, which did
not carry through to the launched browser. Adding only `ldd`'s missing entries
was insufficient; adding the specific X11 directories enabled offline tests.

**Why:** Artifact Playwright and root Puppeteer have independent browser caches.
**How to apply:** Inspect existing browser installations before downloading another
copy, and preserve the narrow library-search-path rule below.

**How to apply:** Preserve only noncredential runtime paths such as
`LD_AUDIT`, `REPLIT_LD_LIBRARY_PATH`, `LD_LIBRARY_PATH`,
`NIX_LD_LIBRARY_PATH`, `NIX_LD` and font configuration when
constructing isolated test environments. Keep external network denial and
credentials excluded. Do not install packages or weaken a test before comparing
native module loading in the ordinary and sanitized processes.

Network-denial controls must remain valid across child-process working-directory
changes.

**Why:** A guard that depends on the parent's working directory can fail before
a child test starts, producing a misleading test failure instead of exercising
the intended security check.

**How to apply:** Preserve credential isolation and verify inherited guards can
load from each subprocess's working directory.

Temporary filesystem quotas can stop a build without a useful compiler log,
even when `df` reports ample free disk.

**Why:** A subsequent tooling write surfaced EDQUOT (`-122`) while repeated
Webpack builds had retained both previous cache packs and unfinished replacement
packs. The build log stopped before either a compiler error or an exit marker.

**How to apply:** Check quota errors and the isolated checkout's generated cache
size before repeating compilation. Remove only disposable generated caches,
preserving source, worktrees and logs. Prefer a managed console workflow for
long-running verification and record its explicit exit result.

When recovering a missing native library in a sanitized build, do not add every
directory from the working Node process's loaded-library map to LD_LIBRARY_PATH.

**Why:** Mixing that process's libc/loader paths into Bash caused an immediate
stack-smashing abort before any test ran. This is distinct from a test failure.

**How to apply:** Locate the specific missing library from a successful native
module load and pass only its directory; retain the toolchain's own libc/loader.

SQL execution fixtures must preserve production enum column types, not replace
them with text.

**Why:** A report passed real PostgreSQL tests with a text status fixture but
failed immediately in production when an invalid enum literal was compared.
Switching to the real enum also exposed fixture statuses that never existed in
the normalized schema.

**How to apply:** Derive disposable test enums from the application's schema
values. Keep provider-native labels in provider fixtures and use normalized
labels in normalized-table fixtures; verify both query execution and population
classification against those labels.
