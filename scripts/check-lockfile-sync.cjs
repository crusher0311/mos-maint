#!/usr/bin/env node
/**
 * Lockfile drift guard.
 *
 * Render builds with `npm ci`, which refuses to install when
 * package.json and package-lock.json are out of sync (exit code
 * EUSAGE). Local development uses `npm install`, which silently
 * repairs the lockfile — so drift only surfaces as a failed
 * production deploy.
 *
 * This check runs `npm ci --dry-run` (no writes, no node_modules
 * changes) and fails fast with a fix hint when the two files
 * disagree, so the smoke chain catches the drift before it reaches
 * Render.
 */
const { spawnSync } = require('node:child_process');

const result = spawnSync('npm', ['ci', '--dry-run'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

// spawn itself failed (npm not found, killed by signal, etc.) — this is an
// environment problem, not lockfile drift. Don't mislabel it.
if (result.error || result.signal) {
  console.error('[lockfile-sync] SKIP — could not run `npm ci --dry-run`.');
  console.error(`[lockfile-sync] reason: ${result.error ? result.error.message : `signal ${result.signal}`}`);
  console.error('[lockfile-sync] This is an environment issue, not lockfile drift.');
  process.exit(1);
}

const combined = `${result.stdout || ''}${result.stderr || ''}`;

if (result.status === 0) {
  console.log('[lockfile-sync] OK — package.json and package-lock.json are in sync.');
  process.exit(0);
}

// Distinguish real drift (the EUSAGE / "Missing from lock file" signatures
// that Render hits) from other npm failures like a registry/network hiccup,
// so transient errors aren't reported as drift.
const driftLines = combined
  .split('\n')
  .filter((line) => /Missing:|Invalid:|can only install packages when|EUSAGE|extraneous/i.test(line));
const isDrift = driftLines.length > 0;

if (isDrift) {
  console.error('[lockfile-sync] FAIL — package.json and package-lock.json are out of sync.');
  console.error('[lockfile-sync] Render builds with `npm ci` and will fail this exact way.');
  console.error('[lockfile-sync] Fix: run `npm install --package-lock-only`, then commit package-lock.json.');
  console.error('[lockfile-sync] --- npm output ---');
  console.error(driftLines.join('\n'));
} else {
  console.error('[lockfile-sync] FAIL — `npm ci --dry-run` failed for a non-drift reason.');
  console.error('[lockfile-sync] This may be a transient registry/network/auth issue — retry before assuming drift.');
  console.error('[lockfile-sync] --- npm output ---');
  console.error(combined.split('\n').slice(0, 20).join('\n'));
}

process.exit(1);
