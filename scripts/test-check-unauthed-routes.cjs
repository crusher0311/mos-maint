#!/usr/bin/env node
// scripts/test-check-unauthed-routes.cjs
//
// Negative and positive regression fixtures for check-unauthed-routes.cjs.
//
// NEGATIVE fixtures prove that the lint CANNOT be bypassed by:
//   1. Importing (but not calling) an auth function.
//   2. Mentioning auth tokens or guard names inside comments.
//   3. Using crypto.createHmac for outbound HMAC computation (not inbound auth).
//
// POSITIVE fixtures prove that genuinely guarded routes still pass.
//
// Run: node scripts/test-check-unauthed-routes.cjs
// Wired into: npm run test:smoke via test:unauthed-routes-fixtures

'use strict';

const { AUTH_PATTERNS, sanitizeForAuthCheck, findLocalAuthHelperNames } = require('./check-unauthed-routes.cjs');

let passed = 0;
let failed = 0;

function guardMatches(content) {
  const sanitized = sanitizeForAuthCheck(content);
  return AUTH_PATTERNS.some((pat) => pat.test(sanitized));
}

function assert(label, cond) {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// NEGATIVE fixtures — these must NOT match any AUTH_PATTERN after sanitization
// (i.e. the lint would correctly flag them as unguarded)
// ---------------------------------------------------------------------------
console.log('\nnegative fixtures (each must NOT match any auth guard)\n');

// [N1] Auth guard only in import — a route that imports getSession but never calls it.
{
  const content = `
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export async function GET(req: NextRequest) {
  const db = await getDb();
  const data = await db.collection("shops").find({}).toArray();
  return NextResponse.json(data);
}
`;
  assert(
    '[N1] import-only getSession (no call) — lint must flag as unguarded',
    !guardMatches(content),
  );
}

// [N2] Auth guard name only in a single-line comment.
{
  const content = `
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";

// TODO: add requirePlatformAdmin() before shipping
export async function GET(req: NextRequest) {
  const db = await getDb();
  const shops = await db.collection("shops").find({}).toArray();
  return NextResponse.json(shops);
}
`;
  assert(
    '[N2] requirePlatformAdmin only in comment — lint must flag as unguarded',
    !guardMatches(content),
  );
}

// [N3] Auth guard name only in a multi-line comment.
{
  const content = `
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";

/**
 * Note: getSession is called by the middleware that wraps this route.
 * CRON_SECRET is validated upstream.
 */
export async function GET(req: NextRequest) {
  const db = await getDb();
  const docs = await db.collection("vehicles").find({}).toArray();
  return NextResponse.json(docs);
}
`;
  assert(
    '[N3] getSession + CRON_SECRET only in JSDoc comment — lint must flag as unguarded',
    !guardMatches(content),
  );
}

// [N4] crypto.createHmac used for OUTBOUND signature (not inbound auth).
//      createHmac was intentionally removed from AUTH_PATTERNS; see lint comments.
{
  const content = `
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import * as crypto from "crypto";

const OUTBOUND_SECRET = process.env.PARTNER_SECRET ?? "";

export async function POST(req: NextRequest) {
  const db = await getDb();
  const body = await req.json();
  // Build outbound HMAC signature to attach to partner request
  const sig = crypto.createHmac("sha256", OUTBOUND_SECRET)
    .update(JSON.stringify(body))
    .digest("hex");
  // Fetch customer data and forward to partner
  const customer = await db.collection("customers").findOne({ _id: body.id });
  return NextResponse.json({ customer, sig });
}
`;
  assert(
    '[N4] createHmac used for outbound (no inbound auth) — lint must flag as unguarded',
    !guardMatches(content),
  );
}

// [N5] Auth function name in a string literal (not a call).
{
  const content = `
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";

export async function GET(req: NextRequest) {
  const db = await getDb();
  // e.g. if someone does: const authFn = "getSession"; eval(authFn + "()")
  const guardName = "requirePlatformAdmin";
  const docs = await db.collection("shops").find({}).toArray();
  return NextResponse.json({ guardName, docs });
}
`;
  assert(
    '[N5] auth function name in a string literal without call syntax — lint must flag as unguarded',
    !guardMatches(content),
  );
}

// [N6] getSession() result discarded — no 401 response within 800 chars.
//      Proves the compound-check pattern catches the "call-but-ignore-result" bypass.
{
  const content = `
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export async function GET(req: NextRequest) {
  // Forgot to check the result
  await getSession();
  const db = await getDb();
  const shops = await db.collection("shops").find({}).toArray();
  return NextResponse.json({ shops });
}
`;
  assert(
    '[N6] getSession() result discarded (no 401 response) — lint must flag as unguarded',
    !guardMatches(content),
  );
}

// ---------------------------------------------------------------------------
// POSITIVE fixtures — these MUST match at least one AUTH_PATTERN (lint passes)
// ---------------------------------------------------------------------------
console.log('\npositive fixtures (each MUST match at least one auth guard)\n');

// [P1] Calls getSession() — standard session auth.
{
  const content = `
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = await getDb();
  const data = await db.collection("shops").findOne({ shopId: session.shopId });
  return NextResponse.json(data);
}
`;
  assert('[P1] getSession() call — lint must pass', guardMatches(content));
}

// [P2] Calls requirePlatformAdmin() — admin-only route.
{
  const content = `
import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export async function GET(req: NextRequest) {
  await requirePlatformAdmin();
  const db = await getDb();
  return NextResponse.json(await db.collection("shops").find({}).toArray());
}
`;
  assert('[P2] requirePlatformAdmin() call — lint must pass', guardMatches(content));
}

// [P3] CRON_SECRET Bearer check — cron-job route with env-var secret.
{
  const content = `
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";

const CRON_SECRET = process.env.CRON_SECRET ?? "";

function isAuthorized(req: NextRequest) {
  const header = req.headers.get("authorization");
  return header === \`Bearer \${CRON_SECRET}\`;
}

export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = await getDb();
  return NextResponse.json(await db.collection("shops").find({}).toArray());
}
`;
  assert('[P3] CRON_SECRET Bearer check — lint must pass', guardMatches(content));
}

// [P4] timingSafeEqual() call — webhook HMAC verification.
{
  const content = `
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import * as crypto from "crypto";

export async function POST(req: NextRequest) {
  const sig = req.headers.get("x-webhook-signature") ?? "";
  const body = await req.text();
  const expected = crypto.createHmac("sha256", process.env.WEBHOOK_SECRET ?? "")
    .update(body).digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }
  const db = await getDb();
  return NextResponse.json({ ok: true });
}
`;
  assert('[P4] timingSafeEqual() call — lint must pass', guardMatches(content));
}

// [P5] validateExtensionToken() — extension API route.
{
  const content = `
import { NextRequest, NextResponse } from "next/server";
import { validateExtensionToken } from "@/lib/extension-route-guard";
import { getDb } from "@/lib/mongo";

export async function GET(req: NextRequest) {
  const shop = await validateExtensionToken(req);
  if (!shop) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = await getDb();
  return NextResponse.json(await db.collection("vehicles").find({ shopId: shop.shopId }).toArray());
}
`;
  assert('[P5] validateExtensionToken() call — lint must pass', guardMatches(content));
}

// [P6] Local auth helper — guard logic extracted into a non-exported helper.
//      Verifies that findLocalAuthHelperNames detects the helper and the handler
//      calling it is considered guarded.
{
  const content = `
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";

const SECRET = process.env.CRON_SECRET ?? "";

function requireCron(req: NextRequest): boolean {
  const header = req.headers.get("authorization");
  return header === \`Bearer \${SECRET}\` || !SECRET;
}

export async function GET(req: NextRequest) {
  if (!requireCron(req)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const db = await getDb();
  return NextResponse.json(await db.collection("shops").find({}).toArray());
}
`;
  // Step 1: file-level check (sanitized)
  const sanitized = sanitizeForAuthCheck(content);
  const fileLevel = AUTH_PATTERNS.some((p) => p.test(sanitized));
  // Step 2: local helper detection
  const helpers = findLocalAuthHelperNames(sanitized);
  const helperCallDetected = [...helpers].some((name) =>
    new RegExp(`\\b${name}\\s*\\(`).test(sanitized)
  );
  assert(
    '[P6] CRON_SECRET in local helper called by handler — lint must pass (via helper detection)',
    fileLevel || helperCallDetected,
  );
}

// [P7] verifyShareToken() — signed report share-link route.
{
  const content = `
import { NextRequest, NextResponse } from "next/server";
import { verifyShareToken } from "@/lib/report-share";

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  const verified = token ? verifyShareToken(token) : null;
  if (!verified) {
    return NextResponse.json({ error: "Invalid or expired report link" }, { status: 403 });
  }
  return NextResponse.json({ ok: true });
}
`;
  assert('[P7] verifyShareToken() call — lint must pass', guardMatches(content));
}

// [P7n] verifyShareToken import-only must NOT pass.
{
  const content = `
import { NextRequest, NextResponse } from "next/server";
import { verifyShareToken } from "@/lib/report-share";

export async function GET(req: NextRequest) {
  return NextResponse.json({ ok: true });
}
`;
  assert('[P7n] import-only verifyShareToken — lint must flag as unguarded', !guardMatches(content));
}

// [P8] consumeExtensionActionGrant() — one-time provider action grant route.
{
  const content = `
import { NextRequest, NextResponse } from "next/server";
import { consumeExtensionActionGrant } from "@/lib/extension-action-grant";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const consumed = await consumeExtensionActionGrant(String(body.grant || ""), {
    provider: "tekmetric",
    action: "print",
  });
  if (consumed.status !== "consumed") {
    return NextResponse.json({ error: "invalid grant" }, { status: 403 });
  }
  return NextResponse.json({ ok: true });
}
`;
  assert('[P8] consumeExtensionActionGrant() call — lint must pass', guardMatches(content));
}

// [P8n] consumeExtensionActionGrant import-only must NOT pass.
{
  const content = `
import { NextRequest, NextResponse } from "next/server";
import { consumeExtensionActionGrant } from "@/lib/extension-action-grant";

export async function POST(request: NextRequest) {
  return NextResponse.json({ ok: true });
}
`;
  assert('[P8n] import-only consumeExtensionActionGrant — lint must flag as unguarded', !guardMatches(content));
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const total = passed + failed;
console.log(`\nauth-lint fixture tests: ${passed}/${total} passed`);
if (failed > 0) {
  console.error(`\n${failed} fixture assertion(s) failed — the auth-guard lint has a bypass or regression.\n`);
  process.exit(1);
}
console.log('All auth-lint fixture assertions passed.\n');
