#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const NEXT_DIR = path.join(process.cwd(), '.next');

const JSON_MANIFESTS = [
  'app-build-manifest.json',
  'build-manifest.json',
  'react-loadable-manifest.json',
  'package.json',
  path.join('server', 'next-font-manifest.json'),
  path.join('server', 'pages-manifest.json'),
  path.join('server', 'app-paths-manifest.json'),
  path.join('server', 'middleware-manifest.json'),
  path.join('server', 'server-reference-manifest.json'),
];

function isCorruptJson(absPath) {
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  if (stat.size === 0) return true;
  let raw;
  try {
    raw = fs.readFileSync(absPath, 'utf8');
  } catch {
    return false;
  }
  if (raw.trim().length === 0) return true;
  try {
    JSON.parse(raw);
    return false;
  } catch {
    return true;
  }
}

function main() {
  if (!fs.existsSync(NEXT_DIR)) return;
  const corrupt = [];
  for (const rel of JSON_MANIFESTS) {
    const abs = path.join(NEXT_DIR, rel);
    if (isCorruptJson(abs)) corrupt.push(rel);
  }
  if (corrupt.length === 0) return;
  console.warn(
    `[dev-cache-guard] Detected corrupted Next.js manifest(s): ${corrupt.join(
      ', ',
    )}. Clearing .next/ to avoid "Unexpected end of JSON input" crashes.`,
  );
  try {
    fs.rmSync(NEXT_DIR, { recursive: true, force: true });
    console.warn('[dev-cache-guard] .next/ cleared.');
  } catch (err) {
    console.warn(
      `[dev-cache-guard] Failed to clear .next/: ${(err && err.message) || err}`,
    );
  }
}

main();
