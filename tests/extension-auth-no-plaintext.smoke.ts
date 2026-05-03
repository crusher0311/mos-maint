/**
 * Smoke test for task #302: the extension auth route must NOT accept a
 * plaintext password fallback. Asserts:
 *
 *   1. A user row with neither a bcrypt nor a scrypt hash returns 401, even
 *      if a matching plaintext `password` field is present (the legacy
 *      fallback that was removed in task #302).
 *   2. A user row with a bcrypt hash returns 200 on the correct password.
 *   3. A user row with a bcrypt hash returns 401 on the wrong password.
 *
 * Uses the `__deps.getDb` test seam exposed by the route to swap in a tiny
 * in-memory fake collection. No real Mongo involvement.
 *
 * Run: `npx tsx tests/extension-auth-no-plaintext.smoke.ts`
 */

import bcrypt from "bcryptjs";
import type { Db } from "mongodb";
import { NextRequest } from "next/server";
import { POST, __deps } from "../app/api/extension/auth/route";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function makeFakeDb(seedUsers: any[]) {
  const usersById = new Map(seedUsers.map((u) => [String(u._id), u]));
  const updates: any[] = [];
  const usersCollection = {
    find(filter: any) {
      const match = (u: any) => !filter?.email || u.email === filter.email;
      return {
        toArray: async () => Array.from(usersById.values()).filter(match),
        project: () => ({ toArray: async () => [] }),
      };
    },
    async updateOne(filter: any, update: any) {
      updates.push({ filter, update });
      const u = usersById.get(String(filter._id));
      if (!u) return { matchedCount: 0 };
      if (update.$set) Object.assign(u, update.$set);
      return { matchedCount: 1 };
    },
  };
  const shopsCollection = {
    find() {
      return {
        project: () => ({ toArray: async () => [] }),
        toArray: async () => [],
      };
    },
  };
  const db = {
    collection(name: string) {
      if (name === "users") return usersCollection;
      if (name === "shops") return shopsCollection;
      return {
        find: () => ({ toArray: async () => [], project: () => ({ toArray: async () => [] }) }),
        updateOne: async () => ({ matchedCount: 0 }),
      };
    },
  } as unknown as Db;
  return { db, updates };
}

function makeReq(body: any): NextRequest {
  return new NextRequest("http://localhost/api/extension/auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  } as any);
}

async function run() {
  console.log("extension-auth-no-plaintext smoke");

  const ORIGINAL = __deps.getDb;

  // (1) plaintext-only user must NOT authenticate (legacy fallback removed)
  {
    const { db } = makeFakeDb([
      {
        _id: "u1",
        email: "plain@example.com",
        password: "letmein",       // plaintext only
        passwordHash: null,
        shopId: 1,
      },
    ]);
    __deps.getDb = async () => db;
    const res = await POST(makeReq({ email: "plain@example.com", password: "letmein" }));
    ok("plaintext-only user returns 401", res.status === 401, `got ${res.status}`);
    const body = await res.json().catch(() => ({}));
    ok("  → response body has error field", typeof body?.error === "string");
  }

  // (2) bcrypt user with correct password returns 200
  {
    const hash = await bcrypt.hash("correct-horse", 4);
    const { db } = makeFakeDb([
      {
        _id: "u2",
        email: "bcrypt@example.com",
        passwordHash: hash,
        shopId: 1,
      },
    ]);
    __deps.getDb = async () => db;
    const res = await POST(makeReq({ email: "bcrypt@example.com", password: "correct-horse" }));
    ok("bcrypt user + correct password returns 200", res.status === 200, `got ${res.status}`);
  }

  // (3) bcrypt user with wrong password returns 401
  {
    const hash = await bcrypt.hash("correct-horse", 4);
    const { db } = makeFakeDb([
      {
        _id: "u3",
        email: "bcrypt2@example.com",
        passwordHash: hash,
        shopId: 1,
      },
    ]);
    __deps.getDb = async () => db;
    const res = await POST(makeReq({ email: "bcrypt2@example.com", password: "wrong" }));
    ok("bcrypt user + wrong password returns 401", res.status === 401, `got ${res.status}`);
  }

  __deps.getDb = ORIGINAL;

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
