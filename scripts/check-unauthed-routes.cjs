#!/usr/bin/env node
/* eslint-disable */
// scripts/check-unauthed-routes.cjs
//
// Prevents unauthenticated data-returning API routes from shipping.
// Mirrors the style of scripts/check-direct-db.cjs (which runs alongside
// this script in the Render prebuild).
//
// Motivation: the Fable5 pen test found /api/debug/* routes that returned
// customer data with zero auth. Task #1126 deleted those routes. This script
// ensures the same pattern cannot recur — any new app/api/**/route.ts that
// reads data without a recognized auth guard will fail the build before it
// reaches production.
//
// How it works:
//   1. Walk every app/api/**/route.ts file.
//   2. Check the file content against a list of recognized auth guard patterns.
//      Any one match is sufficient (routes may use session auth, CRON_SECRET,
//      bearer tokens, webhook HMAC signatures, or the external-API middleware).
//   3. If no guard is found AND the file is not on the PUBLIC_ALLOWLIST of
//      deliberately public routes, the build fails.
//   4. Stale PUBLIC_ALLOWLIST entries (file deleted or now has a guard) trigger
//      a warning so the list stays tidy.
//
// To add a genuinely public route (health ping, public webhook, OAuth callback,
// etc.) add it to PUBLIC_ALLOWLIST below with a short comment explaining why
// no auth is needed. Do NOT add data-returning routes there — fix the route
// by adding an auth guard instead.
//
// To run locally: `node scripts/check-unauthed-routes.cjs`

'use strict';

const fs   = require('node:fs');
const path = require('node:path');

const ROOT    = process.cwd();
const API_DIR = path.join(ROOT, 'app', 'api');

// ---------------------------------------------------------------------------
// Content sanitization
//
// Strip imports and comments BEFORE running auth-pattern matching to prevent
// false positives from:
//   • `import { getSession } from "@/lib/auth"` — importing a guard does not
//     invoke it; mere import presence must not satisfy the check.
//   • `// calls getSession internally` — a comment is not a control-flow path.
//   • `/* CRON_SECRET used in helper below */` — same.
//
// We only strip text, never add or modify code, so the sanitized form is
// safe to run AUTH_PATTERNS against.
// ---------------------------------------------------------------------------
function sanitizeForAuthCheck(text) {
  return text
    // Remove single-line comments (// …) — captures to end of line
    .replace(/\/\/[^\n]*/g, '')
    // Remove multi-line comments (/* … */)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // Remove ES/TS import statements (import … from '…'; or import '…';)
    .replace(/^\s*import\s[\s\S]*?(?:from\s+['"][^'"]+['"])?\s*;?\s*$/gm, '');
}

// ---------------------------------------------------------------------------
// Recognized auth guard patterns
//
// IMPORTANT — design rules that prevent bypasses:
//   1. Function-based guards MUST include `\s*\(` so that a bare import of the
//      function name (`import { getSession }`) does NOT satisfy the check.
//      After sanitization imports are stripped anyway, but the call-syntax
//      requirement is a second, independent layer of defence.
//   2. Flag/variable patterns (isPlatformAdmin, session_token) MUST require
//      a conditional or comparison context to prevent incidental mentions in
//      unrelated code from satisfying the check.
//   3. `crypto.createHmac` is NOT listed — it is also used for OUTBOUND HMAC
//      computation (e.g. building a signature to attach to an outgoing request)
//      and is therefore not proof of inbound authentication.  Routes that do
//      HMAC verification must use `timingSafeEqual`, `verifyHmac`, or a named
//      webhook-specific secret constant listed below.
//   4. Raw environment-variable names (CRON_SECRET, etc.) are intentionally
//      retained because after sanitization (imports + comments stripped) they
//      only appear in actual handler or helper code.  A route that merely reads
//      the variable without checking it would still need to pass the per-handler
//      body check, making an accidental match very unlikely in practice.
//
// Add new patterns here when a new auth mechanism is introduced, following the
// same rules.  Always add a test fixture to scripts/test-check-unauthed-routes.cjs
// that proves both the positive (guarded) and negative (unguarded) cases.
// ---------------------------------------------------------------------------
const AUTH_PATTERNS = [
  // --- Session / admin guards ---
  //
  // requireSession() / requirePlatformAdmin() / requireAdmin() throw (via
  // Next.js redirect()) when the session is absent, so the mere call is
  // sufficient proof of protection.  Call syntax (\s*\() is still required
  // so that a bare import does not satisfy the check.
  /\brequireSession\s*\(/,
  /\brequirePlatformAdmin\s*\(/,
  /\brequireAdmin\s*\(/,

  // getSession() / getServerSession() — COMPOUND PATTERN REQUIRED.
  //
  // A bare `await getSession()` with the result discarded is NOT an auth
  // guard; the pattern below requires that getSession() is paired with a
  // 401 or 403 response within 800 characters in the same handler section.
  // This covers the canonical pattern:
  //   const session = await getSession();
  //   if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  //
  // Discarded-result bypass:
  //   await getSession();   ← no if-check, no 401 → does NOT match
  //   const db = await getDb();
  //   return NextResponse.json({ data });   ← success response, no 401
  //
  // \b40[13]\b matches the literal numbers 401 and 403.  Both forms work:
  //   - NextResponse.json({ error }, { status: 401 })  → "status: 401"
  //   - jsonError(401, "Unauthorized")                 → "401,"
  //   - new Response(body, { status: 401 })            → "status: 401"
  // After comment/import sanitization these only appear in actual code.
  //
  // getSession() accepts an optional request argument (some routes call
  // getSession(req)) so we match `getSession\s*\(` (any args) not `\(\s*\)`.
  /\bgetSession\s*\([\s\S]{0,800}\b40[13]\b/,
  /\bgetServerSession\s*\([\s\S]{0,800}\b40[13]\b/,

  // Platform-admin flag used in a conditional (negation or comparison)
  /!\s*[\w.]+\.isPlatformAdmin|\bisPlatformAdmin\b\s*(?:===?|!==?|&&|\|\|)/,

  // Manual session-token cookie read — string-literal form only
  // (bare `session_token` identifiers in variable names don't count)
  /"session_token"|'session_token'/,

  // Ghost-mode admin cookie name (specific enough)
  /admin_session_token/,

  // Admin-token header / body checks (legacy operator-only routes)
  /X-Admin-Token/,
  /\bADMIN_TOKEN\b/,

  // Cron-job Bearer token (CRON_SECRET read from env — after sanitization
  // this only appears in actual handler or helper code, not imports/comments)
  /\bCRON_SECRET\b/,

  // Extension auth — call syntax required
  /\bvalidateExtensionToken\s*\(/,
  /\bguardExtensionShopRequest\s*\(/,

  // Internal worker secret
  /INTERNAL_WORKER_SECRET/,
  /x-internal-secret/i,

  // External API key middleware — call syntax required
  /\bcreateExternalEndpoint\s*\(/,

  // Stripe webhook signature header (specific header name)
  /stripe-signature/i,

  // Twilio webhook signature — call syntax required
  /\bvalidateTwilioSignature\s*\(/,

  // Timing-safe comparison for HMAC verification — call syntax required
  /\btimingSafeEqual\s*\(/,

  // Named HMAC-verification helpers — call syntax required
  /\bverifyHmac\s*\(/,
  /\bverifySecret\s*\(/,

  // Extracted webhook signature-verification helper — call syntax required.
  // Next's generated route types forbid non-handler exports from route.ts,
  // so HMAC verification may live in a sibling module (e.g.
  // app/api/webhooks/tekmetric/verify-signature.ts) and the route file only
  // shows the call site. Import lines are stripped by sanitization, so a
  // bare import without a call does NOT satisfy this.
  /\bverifySignature\s*\(/,

  // Render log-stream webhook secret
  /\bLOG_STREAM_SECRET\b/,

  // Webhook-specific signing secret constants (specific enough that their
  // presence in code — after comment/import stripping — implies HMAC setup)
  /AUTOFLOW_SIGNING_SECRET/,
  /SHOPMONKEY_WEBHOOK_SIGNING_SECRET/,
  /TEKMETRIC_WEBHOOK_SIGNING_SECRET/,

  // Protractor per-shop webhook token
  /protractorWebhookToken/,

  // Tekmetric migration admin auth — call syntax required
  /\brequireMigAdmin\s*\(/,

  // Signed report share-link verification (REPORT_SHARE_SECRET HMAC) — call
  // syntax required. verifyShareToken() returns null for a bad/expired token
  // and the route 403s without it, so the call is proof of protection.
  /\bverifyShareToken\s*\(/,

  // One-time extension provider-action grant consumption — call syntax
  // required. consumeExtensionActionGrant() atomically validates + burns a
  // server-issued single-use grant (replay-safe); the route 403s unless the
  // grant consumes cleanly.
  /\bconsumeExtensionActionGrant\s*\(/,

  // API key / secret header checks
  /x-api-secret/i,
  /\bX-API-Key\b/,

  // Manual session-token lookup — call syntax required
  /\bfindActiveSessionByToken\s*\(/,

  // E2E test token gate — call syntax required
  /\bisTestAuthEnabled\s*\(/,

  // Dev-only gate — NODE_ENV check ensures route is inaccessible in production
  /NODE_ENV.*development/,
  /NODE_ENV\s*!==?\s*['"]production['"]/,
];

// ---------------------------------------------------------------------------
// Deliberately public routes
// Add a route here ONLY when it is intentionally unauthenticated by design.
// Include a short comment explaining why no auth is needed.
// Do NOT add data-returning routes that just happen to be missing a guard —
// fix the route instead.
// ---------------------------------------------------------------------------
const PUBLIC_ALLOWLIST = new Set([
  // Health / liveness probes — return connection status, never customer data
  "app/api/ping/route.ts",
  "app/api/health/route.ts",
  "app/api/db/health/route.ts",

  // Auth flow — public by design (these ARE the authentication endpoints)
  "app/api/auth/login/route.ts",
  "app/api/auth/logout/route.ts",
  "app/api/auth/forgot/route.ts",
  "app/api/auth/reset/route.ts",
  // Extension passwordless sign-in step 1 — public by design (like forgot):
  // emails a single-use code; never reveals whether the account exists.
  "app/api/extension/auth/request-code/route.ts",
  "app/api/auth/setup/route.ts",
  "app/api/auth/setup-shop/route.ts",
  "app/api/auth/setup-complete/route.ts",
  "app/api/auth/complete-setup/route.ts",
  // Invite acceptance uses a single-use opaque token in the request body
  "app/api/auth/invite/route.ts",
  // Must-change-password flow: requires possession of the must-change-password
  // cookie (issued at login for force-reset accounts) rather than a full session
  "app/api/auth/change-password/route.ts",

  // Extension login — equivalent of auth/login for the browser extension;
  // verifies credentials via bcrypt and issues an extension token
  "app/api/extension/auth/route.ts",

  // Static / non-data responses
  "app/api/extension/download/route.ts",  // serves the extension ZIP; no DB data
  "app/api/extension/version/route.ts",   // returns a hardcoded version string
  "app/api/docs/route.ts",                // OpenAPI spec (no customer data)
  "app/api/docs/ui/route.ts",             // Swagger UI HTML
  "app/api/assets/[filename]/route.ts",   // static logo images (allow-listed filenames only)

  // Public QR-code redirect — reads only the shop's appointment URL and
  // records a scan count; never returns customer data
  "app/api/sticker/redirect/[shopId]/route.ts",

  // Enrollment join link — reads only the enrollment config for the code;
  // the code itself is the credential
  "app/api/join/[code]/route.ts",

  // Public pricing / billing config — only returns Stripe plan prices,
  // not any customer or shop data
  "app/api/billing/config/route.ts",
  "app/api/stripe/prices/route.ts",

  // Tombstoned endpoints — always return 410 Gone with no data
  "app/api/enterprise/billing/purchase-vins/route.ts",
  "app/api/settings/addons/route.ts",
  "app/api/stripe/billing-portal/route.ts",
  "app/api/stripe/setup-card/route.ts",
  "app/api/stripe/change-plan/route.ts",
  "app/api/stripe/create-checkout/route.ts",

  // Public shop logo — served as a binary image for the QR sticker redirect
  // flow. Returns only shop branding assets, never customer data.
  "app/api/sticker/logo/[...path]/route.ts",

  // Dashboard update poll — returns only a single Unix timestamp
  // ({lastUpdate: number}), not any customer or shop data. Used by the
  // dashboard to decide whether to refresh its view.
  "app/api/dashboard/updates/route.ts",

  // Protractor inbound webhook callback — authenticated by a connectionId
  // value in the request payload that Protractor sends and that is validated
  // against the shop's stored integrationId. This is a server-to-server
  // webhook receiver, not a browser-session route.
  "app/api/callbacks/protractor/route.ts",
  // Isolation-test mirror of the above; identical auth and data semantics.
  "app/api/callbacks/protractor-v2/route.ts",

  // Soft-auth endpoints — check getSession() but return EMPTY/ZERO sentinel
  // values for unauthenticated callers rather than a 401.  No customer or shop
  // data is ever returned to an unauthenticated user; the response is
  // indistinguishable from "no data" from the caller's perspective.
  //
  // These routes intentionally do NOT return a 401 because the client expects
  // a success envelope regardless of auth state (e.g. announcement badge
  // silently shows nothing for logged-out users; the pending-count badge
  // shows 0).  Changing them to 401 would break the client-side polling logic.
  "app/api/announcements/active/route.ts",
  "app/api/settings/auto-booking/pending-count/route.ts",
]);

// ---------------------------------------------------------------------------
// Directory walker (identical to check-direct-db.cjs)
// ---------------------------------------------------------------------------
function* walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === 'node_modules' ||
        entry.name === '.next' ||
        entry.name === '_archive' ||
        entry.name === '.git' ||
        entry.name === 'dist' ||
        entry.name === 'build'
      ) continue;
      yield* walk(full);
    } else if (entry.isFile() && entry.name === 'route.ts') {
      yield full;
    }
  }
}

// ---------------------------------------------------------------------------
// Per-handler guard check
//
// For files with more than one exported HTTP handler (GET, POST, PUT, …),
// a guard present in one handler does NOT imply the others are guarded.
// We therefore also run a per-handler scan:
//
//   1. Find every `export async function <VERB>(` position in the file.
//   2. Extract each handler's function body (via brace-counting) so we
//      only examine the code that actually runs for that handler.
//   3. Find all non-exported, locally-defined helper functions in the file
//      whose own body contains a recognized auth guard.  A handler that CALLS
//      one of these helpers is treated as guarded (the guard lives one level
//      up in a shared helper rather than inline — the enterprise-billing /
//      requireEnterpriseAccess() and dev-route / requireDev() patterns).
//   4. Any handler body that neither contains a direct guard pattern NOR calls
//      a local auth helper is reported as an offender.
//
// This catches the credentials-GET pattern (requirePlatformAdmin only in PUT,
// not in GET, and GET doesn't call any auth helper) without false-positives on
// routes that centralise their auth in a local `requireXxx()` function.
// ---------------------------------------------------------------------------

const HANDLER_VERBS_RE = /export\s+async\s+function\s+(GET|POST|PUT|DELETE|PATCH|HEAD)\s*\(/g;
const VERB_NAMES_RE   = /\b(GET|POST|PUT|DELETE|PATCH|HEAD)\s*\(/;

/**
 * Extract a function body by first skipping the parameter list (paren-counting
 * so nested `{ ... }` in TypeScript type annotations are not mistaken for the
 * function body) and then brace-counting the body.
 *
 * Returns the `{...}` slice (inclusive) or null on failure.
 */
function extractFunctionBody(content, sigStart) {
  let i = sigStart;
  const len = content.length;
  // 1. Skip to opening `(` of the parameter list.
  while (i < len && content[i] !== '(') i++;
  if (i >= len) return null;
  // 2. Paren-count to skip the full parameter list.
  let depth = 0;
  while (i < len) {
    const ch = content[i++];
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) break; }
  }
  // 3. Skip return-type annotation to land on the function BODY `{`.
  //    HTTP handler return types are almost always `NextResponse`, `void`, or
  //    `Promise<NextResponse>` — no inline `{ field: type }` object literals.
  //    We therefore use the simple approach: find the next `{`.
  //    For the rare helper with an object return type (e.g. `verifyShareToken`),
  //    findLocalAuthHelperNames uses text-section matching, not this extractor.
  while (i < len && content[i] !== '{') i++;
  if (i >= len) return null;
  // 4. Brace-count the body.
  const start = i;
  depth = 0;
  while (i < len) {
    const ch = content[i++];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return content.slice(start, i); }
  }
  return null;
}

/**
 * Return the set of locally-defined function names in `content` whose own body
 * (directly or one call deep) contains a recognized auth guard.
 *
 * Two-pass algorithm:
 *   Pass 1 — helpers whose body directly matches an AUTH_PATTERN.
 *   Pass 2 — helpers that CALL a Pass-1 helper (one level of indirection).
 *
 * This covers patterns like:
 *   function isAuthorized(req) { … CRON_SECRET … }
 *   async function runChecks(req) { if (!isAuthorized(req)) return 401; }
 *   export async function GET(req) { return runChecks(req); }
 */
function findLocalAuthHelperNames(content) {
  // Use a TEXT-SECTION approach: each local function's "section" spans from its
  // own definition to the start of the next function definition.  This avoids
  // precise body extraction (which breaks on complex TS return-type annotations
  // like `function verifyShareToken(): { vin: string } | null { … }`).
  const fnRe = /(?:^|\n)(?:async\s+)?function\s+(\w+)\s*\(/gm;

  // Collect all non-exported local functions with start positions.
  const localFns = []; // [{name, index}]
  let m;
  while ((m = fnRe.exec(content)) !== null) {
    const name = m[1];
    const lineStart = content.lastIndexOf('\n', m.index) + 1;
    const line = content.slice(lineStart, m.index + m[0].length);
    if (/\bexport\b/.test(line)) continue; // skip exported HTTP handlers
    localFns.push({ name, index: m.index });
  }

  // Build section map: name → text from this function to the next.
  const sectionMap = new Map();
  for (let i = 0; i < localFns.length; i++) {
    const start = localFns[i].index;
    const end   = localFns[i + 1]?.index ?? content.length;
    sectionMap.set(localFns[i].name, content.slice(start, end));
  }

  const helpers = new Set();
  // Pass 1: section directly contains an auth guard.
  for (const [name, section] of sectionMap) {
    if (AUTH_PATTERNS.some((pat) => pat.test(section))) helpers.add(name);
  }
  // Pass 2: section calls a Pass-1 helper (one level of indirection).
  //   e.g. runChecks() calls isAuthorized() which checks CRON_SECRET.
  for (const [name, section] of sectionMap) {
    if (helpers.has(name)) continue;
    for (const h of helpers) {
      if (new RegExp(`\\b${h}\\s*\\(`).test(section)) { helpers.add(name); break; }
    }
  }
  return helpers;
}

/**
 * Detect whether a handler body performs any real data access.
 * Handlers with NO data access are considered pure stubs (method-not-allowed
 * or health-probe responses) and exempt from the per-handler auth check.
 */
const DATA_ACCESS_PATTERNS = [
  /\bgetDb\b/,
  /\.collection\s*\(/,
  /\bfindOne\b/,
  /\b\.find\s*\(/,
  /\baggregate\s*\(/,
  /\bsql`/,
  /\bdb\./,
  /\bfetch\s*\(/,
  /\bfetchWithCache\b/,
  /\bgetSession\b/,          // session reads count as data access for this check
];

// ---------------------------------------------------------------------------
// Main scan
// ---------------------------------------------------------------------------
const offenders = [];

for (const abs of walk(API_DIR)) {
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');

  // Public by design — skip auth check
  if (PUBLIC_ALLOWLIST.has(rel)) continue;

  let content;
  try {
    content = fs.readFileSync(abs, 'utf8');
  } catch {
    continue;
  }

  // Sanitize ONCE per file: remove imports + comments so that auth patterns
  // that appear only in import statements or comments do NOT satisfy the check.
  const sanitized = sanitizeForAuthCheck(content);

  // --- Step 1: file-level guard check (fast path for single-handler files) ---
  const hasGuard = AUTH_PATTERNS.some((pat) => pat.test(sanitized));
  if (!hasGuard) {
    offenders.push(rel);
    continue;
  }

  // --- Step 2: per-handler check (catches guard-in-one-handler-only bugs) ---
  const handlerMatches = [...content.matchAll(HANDLER_VERBS_RE)];
  if (handlerMatches.length < 2) {
    // Single handler or no exported handlers — file-level check is sufficient.
    continue;
  }

  // Build extended pattern set: direct auth + calls to local auth helpers
  // + cross-handler delegation (return GET(req) / return POST(req)).
  // Use sanitized content to detect local auth helper bodies (prevents a helper
  // that only "mentions" a guard in a comment from being counted as one).
  const localAuthHelpers = findLocalAuthHelperNames(sanitized);
  const extendedPatterns = [
    ...AUTH_PATTERNS,
    // calls to local auth-wrapping helpers (requireDev, runChecks, etc.)
    ...[...localAuthHelpers].map((name) => new RegExp(`\\b${name}\\s*\\(`)),
    // cross-handler delegation: `return GET(req)` or `return POST(req)` etc.
    /\breturn\s+(GET|POST|PUT|DELETE|PATCH|HEAD)\s*\(/,
  ];

  for (let i = 0; i < handlerMatches.length; i++) {
    const verb    = handlerMatches[i][1];
    const sigPos  = handlerMatches[i].index;
    const body    = extractFunctionBody(content, sigPos);
    const section = body ?? content.slice(sigPos, handlerMatches[i + 1]?.index ?? content.length);
    // Sanitize the per-handler section too so comments/imports within it
    // cannot inflate the auth-pattern match.
    const sanitizedSection = sanitizeForAuthCheck(section);

    // Exempt: handler has no data access — it's a pure static/error response.
    if (!DATA_ACCESS_PATTERNS.some((pat) => pat.test(sanitizedSection))) continue;

    if (!extendedPatterns.some((pat) => pat.test(sanitizedSection))) {
      offenders.push(`${rel} [${verb}]`);
    }
  }
}

// ---------------------------------------------------------------------------
// Report violations
// ---------------------------------------------------------------------------
if (offenders.length > 0) {
  console.error(
    `\n[check-unauthed-routes] ${offenders.length} route(s) under app/api/ have no recognized auth guard:\n`
  );
  for (const o of offenders) console.error('  -', o);
  console.error(`
Each route must include at least one of the following:
  • getSession() / requireSession() / requirePlatformAdmin() / requireAdmin()
  • CRON_SECRET Bearer-token check
  • validateExtensionToken() or createExternalEndpoint()
  • Webhook HMAC/signature verification (timingSafeEqual, verifyHmac, verifySecret, etc.)
  • A NODE_ENV === 'development' gate (dev-only routes)

If the route is genuinely public (health ping, OAuth callback, static redirect,
etc.) add it to the PUBLIC_ALLOWLIST in scripts/check-unauthed-routes.cjs with
a comment explaining why no auth is needed.

Reminder: never add a data-returning route to the allowlist — add an auth guard
to the route instead.
`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Warn about stale allowlist entries (deleted files only)
//
// NOTE: We intentionally do NOT warn when a public-allowlist route gains an
// auth guard. Public routes like login/logout/forgot naturally contain
// patterns like "session_token" (they set that cookie) or "getSession" (they
// call it post-auth). Their presence on the allowlist is by design — they are
// genuinely public endpoints — not a legacy exception that needs cleaning up.
// Only warn if the file was deleted and the allowlist entry should be removed.
// ---------------------------------------------------------------------------
const stale = [...PUBLIC_ALLOWLIST].filter((rel) => {
  const abs = path.join(ROOT, rel);
  return !fs.existsSync(abs);
});

if (stale.length > 0) {
  console.warn(
    `\n[check-unauthed-routes] ${stale.length} stale PUBLIC_ALLOWLIST entr${stale.length === 1 ? 'y' : 'ies'} ` +
    `(file deleted — remove from scripts/check-unauthed-routes.cjs):\n`
  );
  for (const s of stale) console.warn('  -', s);
}

console.log(
  `[check-unauthed-routes] OK — ${PUBLIC_ALLOWLIST.size - stale.length} allowlisted public route(s); ` +
  `0 unguarded data routes found.`
);

// ---------------------------------------------------------------------------
// Exports (used by scripts/test-check-unauthed-routes.cjs to test fixtures
// without re-scanning the entire app/api directory tree)
// ---------------------------------------------------------------------------
module.exports = { AUTH_PATTERNS, sanitizeForAuthCheck, findLocalAuthHelperNames };
