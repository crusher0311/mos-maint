/**
 * Smoke test: enterprise auto-access in `validateExtensionToken`.
 *
 * An enterprise OWNER/ADMIN must automatically gain extension access to every
 * shop sharing an `enterpriseId` with one of their explicitly-assigned shops,
 * without being hand-added per location. The expansion must be:
 *  - ADDITIVE and role-gated (regular users are untouched), and
 *  - best-effort (a `shops` lookup failure falls back to base access, never a
 *    lockout).
 *
 * Run: `npx tsx tests/extension-auth-enterprise-access.smoke.ts`
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

function req(): NextRequest {
  return new NextRequest("http://localhost/api/extension/features", {
    headers: { Authorization: "Bearer ext_tok" },
  });
}

// Minimal Mongo-ish matcher supporting the two query shapes the helper uses:
// { shopId: { $in: [...] } } and { enterpriseId: { $in: [...] } }.
function matches(doc: any, query: any): boolean {
  return Object.entries(query).every(([field, cond]: [string, any]) => {
    if (cond && typeof cond === "object" && Array.isArray(cond.$in)) {
      return cond.$in.some((v: any) => v === doc[field]);
    }
    return doc[field] === cond;
  });
}

async function run() {
  console.log("extension-auth enterprise auto-access");

  delete process.env.IDENTITY_PG_CANONICAL;
  const authMod = await import("../lib/extension-auth");

  // Team-Ryan-shaped fixture: shops 85/117/118 share enterprise E1; 200 is E2.
  const shops = [
    { shopId: 85, enterpriseId: "E1" },
    { shopId: 117, enterpriseId: "E1" },
    { shopId: 118, enterpriseId: "E1" },
    { shopId: 200, enterpriseId: "E2" },
  ];

  let currentUser: any = null;
  let shopsThrow = false;

  const fakeDb = {
    collection: (name: string) => {
      if (name === "users") {
        return {
          findOne: async () => currentUser,
          updateOne: async () => ({ matchedCount: 1 }),
        };
      }
      if (name === "shops") {
        return {
          find: (query: any) => {
            if (shopsThrow) throw new Error("shops down");
            return {
              project: () => ({
                toArray: async () => shops.filter((s) => matches(s, query)),
              }),
            };
          },
        };
      }
      return { findOne: async () => null, updateOne: async () => ({}) };
    },
  } as any;

  authMod.__deps.getDb = async () => fakeDb;
  authMod.__deps.isIdentityPgCanonical = () => false;

  const baseUser = (role: string) => ({
    _id: "u1",
    email: "owner@tra.com",
    role,
    shopId: 85,
    shopIds: [85],
    extensionToken: "ext_tok",
    extensionTokenCreatedAt: new Date(),
  });

  // (1) owner → expands to the whole enterprise (E1), never E2.
  {
    currentUser = baseUser("owner");
    shopsThrow = false;
    const auth = await authMod.validateExtensionToken(req());
    const ids = authMod.getUserShopIds(auth.user).sort();
    ok("owner authorized", auth.authorized === true, `code=${auth.code}`);
    ok(
      "owner expands to enterprise siblings",
      JSON.stringify(ids) === JSON.stringify(["117", "118", "85"]),
      `got ${JSON.stringify(ids)}`,
    );
    ok("owner does NOT cross into other enterprise (200)", !ids.includes("200"));
  }

  // (2) admin → same expansion.
  {
    currentUser = baseUser("admin");
    shopsThrow = false;
    const auth = await authMod.validateExtensionToken(req());
    const ids = authMod.getUserShopIds(auth.user).sort();
    ok(
      "admin expands to enterprise siblings",
      JSON.stringify(ids) === JSON.stringify(["117", "118", "85"]),
      `got ${JSON.stringify(ids)}`,
    );
  }

  // (3) regular user → NO expansion (keeps only explicit shops).
  {
    currentUser = baseUser("user");
    shopsThrow = false;
    const auth = await authMod.validateExtensionToken(req());
    const ids = authMod.getUserShopIds(auth.user);
    ok(
      "regular user is NOT expanded",
      JSON.stringify(ids) === JSON.stringify(["85"]),
      `got ${JSON.stringify(ids)}`,
    );
  }

  // (4) shops lookup throws → owner falls back to base access, no lockout.
  {
    currentUser = baseUser("owner");
    shopsThrow = true;
    const auth = await authMod.validateExtensionToken(req());
    const ids = authMod.getUserShopIds(auth.user);
    ok("owner still authorized on shops-lookup failure", auth.authorized === true);
    ok(
      "owner falls back to base shopIds on failure",
      JSON.stringify(ids) === JSON.stringify(["85"]),
      `got ${JSON.stringify(ids)}`,
    );
  }

  // (5) requiredShopId for a sibling shop is granted to an owner.
  {
    currentUser = baseUser("owner");
    shopsThrow = false;
    const auth = await authMod.validateExtensionToken(req(), "117");
    ok("owner passes requiredShopId for enterprise sibling", auth.authorized === true, `code=${auth.code}`);
  }

  // (6) requiredShopId for a sibling shop is denied to a regular user.
  {
    currentUser = baseUser("user");
    shopsThrow = false;
    const auth = await authMod.validateExtensionToken(req(), "117");
    ok(
      "regular user denied requiredShopId for non-assigned shop",
      auth.authorized === false && auth.code === "SHOP_FORBIDDEN",
      `code=${auth.code}`,
    );
  }

  if (failed > 0) {
    console.error(`\nTotal failures: ${failed}`);
    process.exit(1);
  }
  console.log("\nAll smoke checks passed.");
  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
