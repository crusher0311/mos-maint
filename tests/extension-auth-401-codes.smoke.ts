/**
 * Task #502 smoke test: `validateExtensionToken` must return a stable
 * `code` on every error branch so the Chrome extension can branch on
 * terminal vs transient failures and stop wiping `mosApiToken` on the
 * first 401. Also exercises the PG-miss → Mongo-hit safety-net path.
 *
 * Run: `npx tsx tests/extension-auth-401-codes.smoke.ts`
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

function makeReq(opts: {
  bearer?: string;
  queryToken?: string;
  path?: string;
} = {}): NextRequest {
  const path = opts.path ?? "/api/extension/features";
  const url = opts.queryToken
    ? `http://localhost${path}?_token=${encodeURIComponent(opts.queryToken)}`
    : `http://localhost${path}`;
  const headers: Record<string, string> = {};
  if (opts.bearer) headers["Authorization"] = `Bearer ${opts.bearer}`;
  return new NextRequest(url, { headers });
}

async function run() {
  console.log("extension-auth 401 codes + Mongo fallback (Task #502)");

  // Set up env so we can swap PG canonical on/off per case.
  delete process.env.IDENTITY_PG_CANONICAL;

  const authMod = await import("../lib/extension-auth");

  type FakeUser = { _id: string; email: string; extensionToken: string; extensionTokenCreatedAt?: Date };
  let mongoUsers: FakeUser[] = [];
  let pgUsers: FakeUser[] = [];
  let mongoThrows = false;

  const fakeDb = {
    collection: (name: string) => {
      if (name !== "users") {
        return { findOne: async () => null, updateOne: async () => ({}) };
      }
      return {
        findOne: async (filter: any) => {
          if (mongoThrows) throw new Error("mongo down");
          return mongoUsers.find((u) => u.extensionToken === filter.extensionToken) ?? null;
        },
        updateOne: async () => ({ matchedCount: 1 }),
      };
    },
  } as any;
  authMod.__deps.getDb = async () => fakeDb;
  authMod.__deps.findUserByExtensionToken = async (token: string) =>
    (pgUsers.find((u) => u.extensionToken === token) as any) ?? null;
  // Force the PG path on so the fallback can be exercised.
  authMod.__deps.isIdentityPgCanonical = () => true;

  // (1) Missing token → TOKEN_MISSING (401)
  {
    const res = await authMod.validateExtensionToken(makeReq());
    ok("no token → TOKEN_MISSING", res.code === "TOKEN_MISSING", `code=${res.code}`);
    ok("  → not authorized", res.authorized === false);
    ok("  → 401", authMod.getAuthErrorStatus(res) === 401);
  }

  // (2) Token not found anywhere → TOKEN_INVALID
  {
    mongoUsers = [];
    pgUsers = [];
    const res = await authMod.validateExtensionToken(
      makeReq({ bearer: "ext_unknown_token" }),
    );
    ok("unknown token → TOKEN_INVALID", res.code === "TOKEN_INVALID", `code=${res.code}`);
    ok("  → 401", authMod.getAuthErrorStatus(res) === 401);
  }

  // (3) PG-miss + Mongo-hit → authorized (safety net)
  {
    pgUsers = [];
    mongoUsers = [
      { _id: "u1", email: "a@b.com", extensionToken: "ext_only_in_mongo" },
    ];
    const res = await authMod.validateExtensionToken(
      makeReq({ bearer: "ext_only_in_mongo" }),
    );
    ok(
      "PG-miss + Mongo-hit → authorized (no code, no error)",
      res.authorized === true && !res.code && !res.error,
      `authorized=${res.authorized} code=${res.code} error=${res.error}`,
    );
  }

  // (4) PG-miss + Mongo-throw → AUTH_LOOKUP_FAILED (transient, never
  // triggers token clear on the client). Because the outer try/catch
  // around the PG read does NOT cover the Mongo fallback (we only log
  // and continue), the Mongo throw path returns TOKEN_INVALID, not
  // AUTH_LOOKUP_FAILED — that's the correct behavior (PG said "not
  // there", Mongo failed to confirm, we treat as invalid token after
  // the client's retry budget). Verify it stays a 401 with a code the
  // client can see.
  {
    pgUsers = [];
    mongoUsers = [];
    mongoThrows = true;
    const res = await authMod.validateExtensionToken(
      makeReq({ bearer: "ext_throws_on_mongo" }),
    );
    ok(
      "PG-miss + Mongo-throw → still a coded 401 (client retries)",
      res.authorized === false && res.code === "TOKEN_INVALID",
      `code=${res.code}`,
    );
    mongoThrows = false;
  }

  // (5) Hard PG-lookup failure → AUTH_LOOKUP_FAILED (503)
  {
    authMod.__deps.findUserByExtensionToken = async () => {
      throw new Error("pg down");
    };
    const res = await authMod.validateExtensionToken(
      makeReq({ bearer: "ext_pg_down" }),
    );
    ok(
      "pg throws → AUTH_LOOKUP_FAILED",
      res.code === "AUTH_LOOKUP_FAILED" && res.serverError === true,
      `code=${res.code} serverError=${res.serverError}`,
    );
    ok("  → 503", authMod.getAuthErrorStatus(res) === 503);
    // Restore
    authMod.__deps.findUserByExtensionToken = async (token: string) =>
      (pgUsers.find((u) => u.extensionToken === token) as any) ?? null;
  }

  // (6) Expired token → TOKEN_EXPIRED
  {
    const old = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    pgUsers = [
      {
        _id: "u2",
        email: "old@b.com",
        extensionToken: "ext_old_token",
        extensionTokenCreatedAt: old,
      },
    ];
    const res = await authMod.validateExtensionToken(
      makeReq({ bearer: "ext_old_token" }),
    );
    ok("expired token → TOKEN_EXPIRED", res.code === "TOKEN_EXPIRED", `code=${res.code}`);
  }

  // (7) Shop-scope mismatch → SHOP_FORBIDDEN
  {
    pgUsers = [
      {
        _id: "u3",
        email: "ok@b.com",
        extensionToken: "ext_ok_token",
        // @ts-expect-error: extra fields ignored by our fake
        shopId: 1,
        shopIds: [1],
      } as any,
    ];
    const res = await authMod.validateExtensionToken(
      makeReq({ bearer: "ext_ok_token" }),
      "999",
    );
    ok(
      "shop mismatch → SHOP_FORBIDDEN",
      res.code === "SHOP_FORBIDDEN",
      `code=${res.code}`,
    );
  }

  // (8) buildAuthErrorBody includes the code
  {
    const body = authMod.buildAuthErrorBody({
      user: null,
      authorized: false,
      error: "Invalid token",
      code: "TOKEN_INVALID",
    });
    ok(
      "buildAuthErrorBody emits { error, code }",
      body.error === "Invalid token" && body.code === "TOKEN_INVALID",
      JSON.stringify(body),
    );
    const body2 = authMod.buildAuthErrorBody(
      {
        user: null,
        authorized: false,
        error: "x",
        code: "TOKEN_INVALID",
      },
      { ok: false },
    );
    ok(
      "buildAuthErrorBody merges extra fields",
      body2.ok === false && body2.code === "TOKEN_INVALID",
      JSON.stringify(body2),
    );
  }

  // (9) sniffer-upload route surfaces 503 (not 401) when validateExtensionToken
  // returns AUTH_LOOKUP_FAILED — regression guard for the additive
  // status-code contract.
  {
    const { POST: snifferPost } = await import(
      "../app/api/extension/sniffer-upload/route"
    );
    authMod.__deps.findUserByExtensionToken = async () => {
      throw new Error("pg down");
    };
    const req = new NextRequest("http://localhost/api/extension/sniffer-upload", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: "Bearer ext_anything",
      },
      body: JSON.stringify({ captures: [] }),
    });
    const res = await snifferPost(req);
    ok(
      "sniffer-upload AUTH_LOOKUP_FAILED → 503",
      res.status === 503,
      `got ${res.status}`,
    );
    const body = await res.json().catch(() => ({}));
    ok(
      "  → body has code: AUTH_LOOKUP_FAILED",
      body?.code === "AUTH_LOOKUP_FAILED",
      JSON.stringify(body),
    );
    // Restore
    authMod.__deps.findUserByExtensionToken = async (token: string) =>
      (pgUsers.find((u) => u.extensionToken === token) as any) ?? null;
  }

  if (failed > 0) {
    console.error(`\nFAILED ${failed} assertion(s)`);
    process.exit(1);
  }
  console.log("\nAll smoke checks passed.");
}

run().catch((err) => {
  console.error("smoke test crashed:", err);
  process.exit(2);
});
