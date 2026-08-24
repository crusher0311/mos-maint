/**
 * Task #1164 — manual extension login must treat tab-supplied provider/shop
 * context as ADVISORY scoping, never a hard gate.
 *
 * The provider-session bootstrap rollout made the sidepanel forward the active
 * tab's provider/smsShopId on manual sign-in. The auth route then 403'd any
 * login whose context didn't resolve to exactly one assigned shop — so a
 * brand-new shop (not yet resolvable by SMS id), an ambiguous context, or a
 * stale/unassigned tab context blocked a login that used to work (seen live:
 * Martin's Tire & Service, shop 376).
 *
 * Contract locked in here:
 *   1. valid creds + unresolvable context  → 200, scoped to the user's shop
 *   2. valid creds + ambiguous context     → 200, scoped to the user's shop
 *   3. valid creds + resolvable context    → 200, scoped to the context shop
 *   4. explicit requestedShopId NOT assigned → 403 (genuine security boundary)
 *   5. context conflicting with an assigned requestedShopId → requested wins
 *
 * Run: npx tsx tests/extension-auth-context-advisory.smoke.ts
 */
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { __deps, POST } from "../app/api/extension/auth/route";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function run() {
  console.log("extension auth: tab context is advisory, not a gate");

  const passwordHash = await bcrypt.hash("correct-horse", 4);
  const user = {
    _id: { toString: () => "u1" },
    email: "advisor@example.com",
    name: "Alex",
    passwordHash,
    shopId: 10,
    shopIds: [10, 11],
    role: "admin",
  };
  const shops = [
    {
      shopId: 10,
      name: "Primary Shop",
      integrationProvider: "tekmetric",
      tekmetric: { shopId: 1111 },
    },
    {
      shopId: 11,
      name: "Second Shop",
      integrationProvider: "tekmetric",
      tekmetric: { shopId: 2222 },
    },
  ];

  let issuedInput: any = null;
  const fakeDb = {
    collection: (name: string) => ({
      find: (query: any) => ({
        toArray: async () => {
          if (name === "users") return [user];
          if (name === "shops") return shops;
          return [];
        },
        project: () => ({
          toArray: async () => (name === "shops" ? shops : []),
        }),
      }),
      updateOne: async () => ({}),
    }),
  } as any;

  __deps.getDb = (async () => fakeDb) as any;
  __deps.issueExtensionSession = (async (input: any) => {
    issuedInput = input;
    return {
      token: "exts_fixture",
      principal: {
        sessionId: "s1",
        assurance: "verified",
        userId: "u1",
        shopId: input.shopId,
        provider: input.provider,
        capabilities: ["read", "write"],
        expiresAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    };
  }) as any;
  __deps.lookupExtensionSession = (async () => ({ status: "invalid" })) as any;
  __deps.revokeExtensionSession = (async () => undefined) as any;

  const login = (body: Record<string, unknown>) =>
    POST(
      new NextRequest("http://localhost/api/extension/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "advisor@example.com",
          password: "correct-horse",
          ...body,
        }),
      }),
    );

  // 1. Unresolvable context (new shop's SMS id unknown to this account)
  issuedInput = null;
  let res = await login({ provider: "tekmetric", smsShopId: "999999" });
  let body: any = await res.json();
  ok(
    "unresolvable context: login succeeds (no 403)",
    res.status === 200 && !!body.token,
    `status=${res.status} body=${JSON.stringify(body)}`,
  );
  ok(
    "unresolvable context: scoped to the user's own shop",
    issuedInput?.shopId === 10 && issuedInput?.provider === "tekmetric",
    JSON.stringify(issuedInput),
  );
  ok(
    "unresolvable context: unmatched sms id is not echoed as the session shop",
    body.session?.smsShopId === "1111",
    JSON.stringify(body.session),
  );

  // 2. Ambiguous context (same SMS id on two assigned shops)
  const dup = shops[1].tekmetric.shopId;
  shops[1].tekmetric.shopId = 1111;
  issuedInput = null;
  res = await login({ provider: "tekmetric", smsShopId: "1111" });
  body = await res.json();
  ok(
    "ambiguous context: login succeeds (no 403)",
    res.status === 200 && !!body.token,
    `status=${res.status}`,
  );
  ok("ambiguous context: scoped to the user's own shop", issuedInput?.shopId === 10);
  shops[1].tekmetric.shopId = dup;

  // 3. Resolvable context scopes to the context shop
  issuedInput = null;
  res = await login({ provider: "tekmetric", smsShopId: "2222" });
  body = await res.json();
  ok(
    "resolvable context: scoped to the context shop",
    res.status === 200 && issuedInput?.shopId === 11,
    `status=${res.status} issued=${JSON.stringify(issuedInput)}`,
  );
  ok(
    "resolvable context: session echoes the matched sms id",
    body.session?.smsShopId === "2222",
  );

  // 4. Explicit requestedShopId the user is NOT assigned to → 403 (kept)
  res = await login({ shopId: 99 });
  body = await res.json();
  ok(
    "unassigned explicit requestedShopId still 403s",
    res.status === 403,
    `status=${res.status} body=${JSON.stringify(body)}`,
  );

  // 5. Context conflicts with an assigned requestedShopId → requested wins
  issuedInput = null;
  res = await login({ shopId: 10, provider: "tekmetric", smsShopId: "2222" });
  body = await res.json();
  ok(
    "conflicting context: explicit requested shop wins, no 403",
    res.status === 200 && issuedInput?.shopId === 10,
    `status=${res.status} issued=${JSON.stringify(issuedInput)}`,
  );

  // 6. Bad credentials still fail with the real auth error
  res = await login({ password: "wrong", provider: "tekmetric", smsShopId: "999999" });
  body = await res.json();
  ok(
    "bad credentials still 401 with a real auth error",
    res.status === 401 && /invalid email or password/i.test(body.error || ""),
    `status=${res.status} body=${JSON.stringify(body)}`,
  );

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll checks passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
