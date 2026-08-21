/**
 * Multi-device concurrent-session smoke test.
 *
 * Before the fix: every successful /api/extension/auth login overwrote the
 * single `users.extensionToken` slot, so any second device's login killed
 * the first device's token in the DB. The first device's next request hit
 * `[Extension Auth] Token not found in DB` → 401 TOKEN_INVALID → background.js
 * destroyed its token (only TOKEN_INVALID hard-clears per task #502) → silent
 * re-auth minted a new token → killed the second device's token → loop.
 * Production observed 74x /labor-rates 401s in 4h for one shop (Kennedy Auto
 * Solutions, shop 57) and the user's "Add canned job" click was being dropped
 * client-side by MOS_SESSION_SOFT_EXPIRED before reaching the server.
 *
 * After the fix:
 *   1. /api/extension/auth pushes every issued token into `extensionTokens[]`
 *      (capped, pruned by age) AND still writes `extensionToken` for back-compat.
 *   2. `validateExtensionToken` accepts any token that matches EITHER the
 *      scalar `extensionToken` OR an entry of `extensionTokens[].token`, so
 *      an older device's still-fresh token keeps working.
 *   3. Older tokens use their own per-entry createdAt for the 30-day TTL —
 *      they do NOT inherit the most-recent login's createdAt.
 *
 * Run: `npx tsx tests/extension-auth-multi-token.smoke.ts`
 */

import { NextRequest } from "next/server";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function makeReq(bearer: string, path = "/api/extension/labor-rates") {
  return new NextRequest(`http://localhost${path}`, {
    headers: { Authorization: `Bearer ${bearer}` },
  });
}

async function run() {
  console.log("extension-auth multi-device concurrent sessions");

  delete process.env.IDENTITY_PG_CANONICAL;

  const authMod = await import("../lib/extension-auth");

  type FakeUser = {
    _id: string;
    email: string;
    extensionToken?: string;
    extensionTokenCreatedAt?: Date;
    extensionTokens?: Array<{ token: string; createdAt: Date; lastUsedAt?: Date }>;
  };

  let mongoUser: FakeUser | null = null;
  const updates: Array<{ filter: any; update: any; options?: any }> = [];

  const fakeDb = {
    collection: (name: string) => {
      if (name !== "users") {
        return { findOne: async () => null, updateOne: async () => ({}) };
      }
      return {
        findOne: async (filter: any) => {
          if (!mongoUser) return null;
          // Honor the $or filter the validator uses.
          if (filter?.$or) {
            for (const cond of filter.$or) {
              if (cond.extensionToken && mongoUser.extensionToken === cond.extensionToken) return mongoUser;
              if (cond.extensionTokens?.$elemMatch?.token) {
                const t = cond.extensionTokens.$elemMatch.token;
                if (mongoUser.extensionTokens?.some((e) => e.token === t)) return mongoUser;
              }
            }
            return null;
          }
          if (filter?.extensionToken && mongoUser.extensionToken === filter.extensionToken) return mongoUser;
          return null;
        },
        updateOne: async (filter: any, update: any, options?: any) => {
          updates.push({ filter, update, options });
          return { matchedCount: 1 };
        },
      };
    },
  } as any;

  authMod.__deps.getDb = (async () => fakeDb) as any;
  authMod.__deps.findUserByExtensionToken = (async () => null) as any;
  authMod.__deps.updateUserExtensionTokenTimestamp = (async () => undefined) as any;
  authMod.__deps.isIdentityPgCanonical = (() => false) as any;

  // ---------- Case 1: stale scalar, valid array entry ----------
  // Device A logged in first (token A), Device B logged in second (token B
  // is now the scalar). Device A's next request must still succeed.
  const now = Date.now();
  const tokA = "ext_user_111_A_xxx";
  const tokB = "ext_user_111_B_yyy";
  mongoUser = {
    _id: "u1",
    email: "advisor@example.com",
    extensionToken: tokB, // newest
    extensionTokenCreatedAt: new Date(now - 60_000), // 1 min ago
    extensionTokens: [
      { token: tokB, createdAt: new Date(now - 60_000), lastUsedAt: new Date(now - 60_000) },
      { token: tokA, createdAt: new Date(now - 3 * 24 * 60 * 60 * 1000), lastUsedAt: new Date(now - 3 * 24 * 60 * 60 * 1000) }, // 3 days old
    ],
  };

  const resA = await authMod.validateExtensionToken(makeReq(tokA));
  ok("stale device-A token is accepted (multi-session)", resA.authorized === true, JSON.stringify(resA));

  const resB = await authMod.validateExtensionToken(makeReq(tokB));
  ok("newest device-B token still accepted (scalar path)", resB.authorized === true, JSON.stringify(resB));

  // ---------- Case 2: per-token TTL is independent ----------
  // Device C's token is 31 days old in the array; the scalar is fresh. The
  // 30-day expiry MUST apply to C's own entry, not inherit the scalar's.
  const tokC = "ext_user_111_C_zzz";
  const tokD = "ext_user_111_D_www";
  mongoUser = {
    _id: "u1",
    email: "advisor@example.com",
    extensionToken: tokD,
    extensionTokenCreatedAt: new Date(now - 60_000),
    extensionTokens: [
      { token: tokD, createdAt: new Date(now - 60_000), lastUsedAt: new Date(now - 60_000) },
      { token: tokC, createdAt: new Date(now - 31 * 24 * 60 * 60 * 1000), lastUsedAt: new Date(now - 31 * 24 * 60 * 60 * 1000) },
    ],
  };
  const resC = await authMod.validateExtensionToken(makeReq(tokC));
  ok("31-day-old array token expires independently", resC.authorized === false && resC.code === "TOKEN_EXPIRED",
    JSON.stringify(resC));
  const resD = await authMod.validateExtensionToken(makeReq(tokD));
  ok("fresh scalar token unaffected by sibling's expiry", resD.authorized === true, JSON.stringify(resD));

  // ---------- Case 3: unknown token still TOKEN_INVALID ----------
  const resBogus = await authMod.validateExtensionToken(makeReq("ext_user_111_BOGUS"));
  ok("unknown token returns TOKEN_INVALID (no false positives)",
    resBogus.authorized === false && resBogus.code === "TOKEN_INVALID",
    JSON.stringify(resBogus));

  // ---------- Case 4: compatibility reads never renew legacy tokens ----------
  // Token E is 8 days old and remains valid within the fixed 30-day window,
  // but validation must not move either timestamp forward.
  updates.length = 0;
  const tokE = "ext_user_111_E_old";
  const tokF = "ext_user_111_F_new";
  mongoUser = {
    _id: "u1",
    email: "advisor@example.com",
    extensionToken: tokF,
    extensionTokenCreatedAt: new Date(now - 60_000),
    extensionTokens: [
      { token: tokF, createdAt: new Date(now - 60_000), lastUsedAt: new Date(now - 60_000) },
      { token: tokE, createdAt: new Date(now - 8 * 24 * 60 * 60 * 1000), lastUsedAt: new Date(now - 8 * 24 * 60 * 60 * 1000) },
    ],
  };
  const resE = await authMod.validateExtensionToken(makeReq(tokE));
  ok("8-day-old array token still accepted (within 30d TTL)", resE.authorized === true, JSON.stringify(resE));
  ok(
    "legacy compatibility read did not renew any token timestamp",
    updates.length === 0,
    `updates seen: ${JSON.stringify(updates)}`,
  );

  console.log(`\nTotal failures: ${failed}`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error("test crashed:", err);
  process.exit(1);
});
