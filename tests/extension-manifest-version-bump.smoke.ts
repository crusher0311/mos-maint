/**
 * Smoke test: when any file under mos-tools-extension/ is changed in
 * the most recent commit (HEAD vs HEAD~1), the manifest.json `version`
 * field MUST also have changed in the same diff.
 *
 * Rationale: the post-merge `ext:auto-publish` hook ONLY pushes a new
 * extension build to the Chrome Web Store when manifest.json's version
 * field changes since HEAD~1. Without this gate, behavior changes in
 * sidepanel.js / background.js / etc. silently never reach users.
 *
 * Failure modes that are intentionally tolerated (test exits 0):
 *   - HEAD~1 doesn't exist (initial commit, shallow clone)
 *   - git not available on PATH (some sandboxed runners)
 *   - The most recent commit didn't touch the extension at all
 *   - Only manifest.json changed (e.g. version bump only)
 */

import { execSync } from "node:child_process";

function safeGit(args: string): string | null {
  try {
    return execSync(`git ${args}`, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

function main(): void {
  const headParent = safeGit("rev-parse HEAD~1");
  if (!headParent) {
    console.log("[ext-manifest-bump] HEAD~1 unavailable (initial commit / shallow clone) — skipping");
    return;
  }

  const changedRaw = safeGit("diff HEAD~1 HEAD --name-only -- mos-tools-extension/");
  if (changedRaw === null) {
    console.log("[ext-manifest-bump] git diff failed — skipping");
    return;
  }

  const changedFiles = changedRaw
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);

  if (changedFiles.length === 0) {
    console.log("[ext-manifest-bump] no extension files changed in HEAD — pass");
    return;
  }

  const nonManifestChanges = changedFiles.filter(
    (f) => f !== "mos-tools-extension/manifest.json"
  );

  if (nonManifestChanges.length === 0) {
    console.log("[ext-manifest-bump] only manifest.json changed — pass");
    return;
  }

  const manifestDiff = safeGit("diff HEAD~1 HEAD -- mos-tools-extension/manifest.json");
  if (manifestDiff === null) {
    console.log("[ext-manifest-bump] couldn't read manifest diff — skipping");
    return;
  }

  const versionLineChanged = /^[+-]\s*"version"\s*:/m.test(manifestDiff);

  if (!versionLineChanged) {
    console.error("[ext-manifest-bump] FAIL: extension files changed in HEAD but manifest.json `version` was not bumped.");
    console.error("Changed extension files:");
    for (const f of nonManifestChanges) {
      console.error("  - " + f);
    }
    console.error("");
    console.error("The auto-publish hook only ships a new Chrome Web Store build when manifest.json's `version` field changes between HEAD~1 and HEAD.");
    console.error("Bump the `version` field in mos-tools-extension/manifest.json (e.g. 1.26.8 -> 1.26.9) in the SAME commit and try again.");
    process.exit(1);
  }

  console.log(`[ext-manifest-bump] PASS — ${nonManifestChanges.length} extension file(s) changed AND manifest version was bumped`);
}

main();
