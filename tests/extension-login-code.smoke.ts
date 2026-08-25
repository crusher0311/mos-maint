/**
 * Smoke test for the passwordless extension sign-in (emailed one-time code).
 *
 * POST /api/extension/auth with { email, loginCode } (no password) must:
 *   1. Issue a verified session when the code matches an unexpired, unused
 *      extension_login_codes row (single-use: it gets consumed).
 *   2. Reject a wrong code with 401 and increment attempts.
 *   3. Reject a replayed (already used) code with 401.
 *   4. Reject an expired code with 401.
 *   5. Reject once the attempt cap (5) is reached, even with the right code.
 *   6. Reject requests with neither password nor loginCode with 400.
 *
 * Uses the `__deps` test seam; no real Mongo/network.
 *
 * Run: `npx tsx tests/extension-login-code.smoke.ts`
 */

import crypto from "node:crypto";
import type { Db } from "mongodb";
import { NextRequest } from "next/server";
import { POST, __deps } from "../app/api/extension/auth/route";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

function makeFakeDb(users: any[], codes: any[]) {
  const usersCollection = {
    find(filter: any) {
      const match = (u: any) => !filter?.email || u.email === filter.email;
      return {
        toArray: async () => users.filter(match),
        project: () => ({ toArray: async () => [] }),
      };
    },
    async updateOne() {
      return { matchedCount: 1 };
    },
  };
  const codesCollection = {
    async findOne(filter: any, opts: any) {
      const now = filter?.expiresAt?.$gt ?? new Date();
      const matches = codes
        .filter(
          (c) =>
            c.emailLower === filter.emailLower &&
            c.usedAt === null &&
            c.expiresAt.getTime() > now.getTime(),
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      void opts;
      return matches[0] ?? null;
    },
    async updateOne(filter: any, update: any) {
      const c = codes.find(
        (x) => x._id === filter._id && (!("usedAt" in filter) || x.usedAt === filter.usedAt),
      );
      if (!c) return { matchedCount: 0, modifiedCount: 0 };
      if (update.$set) Object.assign(c, update.$set);
      if (update.$inc?.attempts) c.attempts = (c.attempts || 0) + update.$inc.attempts;
      return { matchedCount: 1, modifiedCount: 1 };
    },
  };
  const shopsCollection = {
    find() {
      const first = users[0];
      return {
        project: () => ({
          toArray: async () =>
            first?.shopId == null
              ? []
              : [
                  {
                    shopId: Number(first.shopId),
                    name: "Test Shop",
                    integrationProvider: "tekmetric",
                    tekmetric: { shopId: 99 },
                  },
                ],
        }),
        toArray: async () => [],
      };
    },
  };
  const db = {
    collection(name: string) {
      if (name === "users") return usersCollection;
      if (name === "shops") return shopsCollection;
      if (name === "extension_login_codes") return codesCollection;
      return {
        find: () => ({ toArray: async () => [], project: () => ({ toArray: async () => [] }) }),
        updateOne: async () => ({ matchedCount: 0 }),
        findOne: async () => null,
      };
    },
  } as unknown as Db;
  return db;
}

function makeReq(body: any): NextRequest {
  return new NextRequest("http://localhost/api/extension/auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  } as any);
}

const USER = { _id: "u1", email: "tech@example.com", passwordHash: null, shopId: 1 };
const futureCode = (code: string, extra: Partial<any> = {}) => ({
  _id: "c1",
  emailLower: "tech@example.com",
  codeHash: sha256(code),
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  usedAt: null,
  attempts: 0,
  ...extra,
});

async function run() {
  console.log("extension-login-code smoke");

  const ORIG = { getDb: __deps.getDb, issue: __deps.issueExtensionSession, lookup: __deps.lookupExtensionSession };
  __deps.issueExtensionSession = (async (input: any) => ({
    token: "exts_test_opaque",
    principal: {
      sessionId: "test-session",
      userId: input.userId,
      shopId: input.shopId,
      provider: input.provider,
      assurance: "verified",
      capabilities: ["read", "write", "provider_action"],
      expiresAt: new Date(Date.now() + 60_000),
    },
  })) as any;

  // (1) valid code → 200 verified session, code consumed
  {
    const codes = [futureCode("123456")];
    __deps.getDb = async () => makeFakeDb([USER], codes);
    const res = await POST(makeReq({ email: "tech@example.com", loginCode: "123456" }));
    ok("valid code returns 200", res.status === 200, `got ${res.status}`);
    const body = await res.json().catch(() => ({}));
    ok("valid code issues token", typeof body.token === "string" && body.token.startsWith("exts_"));
    ok("code is consumed (single-use)", codes[0].usedAt !== null);

    // (3) replay of the same (now used) code → 401
    const replay = await POST(makeReq({ email: "tech@example.com", loginCode: "123456" }));
    ok("replayed code returns 401", replay.status === 401, `got ${replay.status}`);
  }

  // (2) wrong code → 401 + attempts incremented
  {
    const codes = [futureCode("123456")];
    __deps.getDb = async () => makeFakeDb([USER], codes);
    const res = await POST(makeReq({ email: "tech@example.com", loginCode: "654321" }));
    ok("wrong code returns 401", res.status === 401, `got ${res.status}`);
    ok("wrong code increments attempts", codes[0].attempts === 1, `attempts=${codes[0].attempts}`);
  }

  // (4) expired code → 401
  {
    const codes = [futureCode("123456", { expiresAt: new Date(Date.now() - 1000) })];
    __deps.getDb = async () => makeFakeDb([USER], codes);
    const res = await POST(makeReq({ email: "tech@example.com", loginCode: "123456" }));
    ok("expired code returns 401", res.status === 401, `got ${res.status}`);
  }

  // (5) attempt cap: 5 prior failures block even the right code
  {
    const codes = [futureCode("123456", { attempts: 5 })];
    __deps.getDb = async () => makeFakeDb([USER], codes);
    const res = await POST(makeReq({ email: "tech@example.com", loginCode: "123456" }));
    ok("attempt-capped code returns 401", res.status === 401, `got ${res.status}`);
  }

  // (6) neither password nor code → 400
  {
    __deps.getDb = async () => makeFakeDb([USER], []);
    const res = await POST(makeReq({ email: "tech@example.com" }));
    ok("missing credential returns 400", res.status === 400, `got ${res.status}`);
  }

  __deps.getDb = ORIG.getDb;
  __deps.issueExtensionSession = ORIG.issue;
  __deps.lookupExtensionSession = ORIG.lookup;

  if (failed > 0) {
    console.error(`extension login code: FAIL (${failed})`);
    process.exit(1);
  }
  console.log("extension login code: PASS");
}

run().catch((err) => {
  console.error("unexpected error", err);
  process.exit(1);
});
