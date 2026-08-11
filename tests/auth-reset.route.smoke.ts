/**
 * Route-level smoke test for POST /api/auth/reset (task: email-link
 * password reset).
 *
 * Run: `npx tsx tests/auth-reset.route.smoke.ts`
 *
 * Locks in the field contract between the reset form and the reset API:
 *  - happy path: token + email + password accepted (both `password` and
 *    the legacy `newPassword` key), token marked used, sessions rotated
 *  - missing-field error returns the 400 validation message
 *  - invalid/expired token returns a clear 400
 *
 * `getDb` and the PG dual-write mirrors are swapped via the route's
 * `__deps` test seam so this runs without a real DB.
 */

import assert from "node:assert/strict";

import { POST, __deps } from "../app/api/auth/reset/route";
import { makeFakeDb } from "./utils/fake-mongo";

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function makeReq(body: any): Request {
  return new Request("http://localhost/api/auth/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function seedDb() {
  const future = new Date(Date.now() + 60 * 60 * 1000);
  const fake = makeFakeDb({
    password_reset_tokens: [
      {
        _id: "tok1",
        token: "good-token",
        userId: "u1",
        shopId: 42,
        emailLower: "jane@example.com",
        expiresAt: future,
        usedAt: null,
      },
    ],
    users: [{ _id: "u1", emailLower: "jane@example.com", shopId: 42 }],
    sessions: [{ _id: "s-old", token: "old", userId: "u1", shopId: 42 }],
  });
  return fake;
}

async function main() {
  const origDeps = { ...__deps };
  const pgCalls: string[] = [];

  async function run(body: any, fake = seedDb()) {
    __deps.getDb = (async () => fake.db) as any;
    __deps.dualWritePgIdentity = (async (label: string, fn: any) => {
      pgCalls.push(label);
    }) as any;
    const res = await POST(makeReq(body));
    const json = await res.json().catch(() => ({}));
    return { res, json, fake };
  }

  try {
    // ---- 1) Missing-field validation ----
    {
      const { res, json } = await run({ email: "jane@example.com", token: "good-token" });
      ok("missing password → 400", res.status === 400);
      ok(
        "missing password → validation message",
        json.error === "Email, password, and token are required."
      );
    }
    {
      const { res } = await run({ email: "jane@example.com", password: "hunter22" });
      ok("missing token → 400", res.status === 400);
    }

    // ---- 2) Happy path with `password` ----
    {
      const { res, json, fake } = await run({
        token: "good-token",
        email: "Jane@Example.com ",
        password: "hunter22",
      });
      ok("password key → 200", res.status === 200, JSON.stringify(json));
      ok("password key → ok:true + shopId", json.ok === true && json.shopId === 42);
      const tok = fake.db.collection("password_reset_tokens");
      const t = await tok.findOne({ token: "good-token" });
      ok("token marked used", !!t?.usedAt);
      const user = await fake.db.collection("users").findOne({ _id: "u1" });
      ok("passwordHash written", typeof user?.passwordHash === "string" && user.passwordHash.length > 20);
      const sess = fake.collections["sessions"];
      ok("old session revoked, new one issued", sess.length === 1 && sess[0].token !== "old");
      ok(
        "session cookie set",
        String(res.headers.get("set-cookie") || "").includes("session_token=")
      );
      ok(
        "PG mirrors invoked",
        pgCalls.includes("users.update(password-reset)") &&
          pgCalls.includes("sessions.delete(reset)") &&
          pgCalls.includes("sessions.insert(reset)")
      );
    }

    // ---- 3) Happy path with legacy `newPassword` key ----
    {
      const { res, json } = await run({
        token: "good-token",
        email: "jane@example.com",
        newPassword: "hunter22",
      });
      ok("legacy newPassword key → 200", res.status === 200, JSON.stringify(json));
    }

    // ---- 4) Bad / expired token ----
    {
      const { res, json } = await run({
        token: "nope",
        email: "jane@example.com",
        password: "hunter22",
      });
      ok("unknown token → 400", res.status === 400);
      ok("unknown token → clear message", json.error === "Invalid or expired token.");
    }
    {
      const fake = seedDb();
      const t = fake.collections["password_reset_tokens"][0];
      t.expiresAt = new Date(Date.now() - 1000);
      const { res, json } = await run(
        { token: "good-token", email: "jane@example.com", password: "hunter22" },
        fake
      );
      ok("expired token → 400", res.status === 400);
      ok("expired token → clear message", json.error === "Invalid or expired token.");
    }

    // ---- 5) Email mismatch ----
    {
      const { res, json } = await run({
        token: "good-token",
        email: "other@example.com",
        password: "hunter22",
      });
      ok("email mismatch → 400", res.status === 400);
      ok("email mismatch → message", json.error === "Email mismatch for this reset token.");
    }
  } finally {
    Object.assign(__deps, origDeps);
  }

  if (failed > 0) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll auth-reset route assertions passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
