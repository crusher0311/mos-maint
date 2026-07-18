/**
 * Smoke test for the multi-provider shop lookup helper.
 *
 * Run: `npx tsx tests/extension-shop-lookup.smoke.ts`
 *
 * `lib/extension-shop-lookup.findShopBySmsId` is the single point that resolves
 * an "SMS shop id" coming from any extension provider (Tekmetric numeric/string,
 * Protractor connectionId, Shopware tenant subdomain/id, Autoflow domain) into
 * an internal MOS shopId. A regression in its $or query, type coercion, or
 * shopware-fallback branch would silently 404 every shop-scoped extension route
 * — exactly the class of break that hurts during the DB cutover.
 *
 * This test swaps `__deps.getDb` to point at the in-memory fake mongo and pins:
 *   - Tekmetric numeric and string shopId match.
 *   - Protractor connectionId match.
 *   - Shopware tenantSubdomain match.
 *   - Autoflow domain-with-suffix match.
 *   - Platform-admin sees any shop; non-admin scoped to userShopIds is denied.
 *   - Shopware fallback auto-associates a single tenantId candidate.
 *   - Returns null when nothing matches.
 *   - Provider field is inferred when not stamped on the doc.
 */

import { __deps, findShopBySmsId } from "../lib/extension-shop-lookup";
import { makeFakeDb } from "./utils/fake-mongo";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function withFakeDb(
  seed: Record<string, any[]>,
  discover?: (apiKey: string) => Promise<{ companyId: string | null; locationId: string | null }>,
) {
  const fake = makeFakeDb(seed);
  const originalGetDb = __deps.getDb;
  const originalDiscover = __deps.discoverShopmonkeyIds;
  __deps.getDb = async () => fake.db as any;
  if (discover) __deps.discoverShopmonkeyIds = discover;
  return {
    fake,
    restore: () => {
      __deps.getDb = originalGetDb;
      __deps.discoverShopmonkeyIds = originalDiscover;
    },
  };
}

async function run() {
  console.log("extension-shop-lookup smoke");

  // 1. Tekmetric numeric match
  {
    const { fake, restore } = withFakeDb({
      shops: [
        { shopId: 42, "tekmetric": { shopId: 100 }, integrationProvider: "tekmetric" },
      ],
    });
    try {
      const r = await findShopBySmsId("100", { isPlatformAdmin: true });
      ok("tekmetric numeric shopId resolves to MOS shopId", r?.mosShopId === 42);
      ok("tekmetric provider inferred", r?.provider === "tekmetric");
    } finally {
      restore();
    }
    void fake;
  }

  // 2. Tekmetric string match (e.g. when stored as string in some shops)
  {
    const { restore } = withFakeDb({
      shops: [
        { shopId: 7, tekmetricShopId: "555", integrationProvider: "tekmetric" },
      ],
    });
    try {
      const r = await findShopBySmsId("555", { isPlatformAdmin: true });
      ok("tekmetric stringy shopId resolves", r?.mosShopId === 7);
    } finally {
      restore();
    }
  }

  // 3. Protractor connectionId match
  {
    const { restore } = withFakeDb({
      shops: [
        { shopId: 11, "protractor": { connectionId: "abc-123" }, integrationProvider: "protractor" },
      ],
    });
    try {
      const r = await findShopBySmsId("abc-123", { isPlatformAdmin: true });
      ok("protractor connectionId resolves", r?.mosShopId === 11);
      ok("protractor provider preserved", r?.provider === "protractor");
    } finally {
      restore();
    }
  }

  // 4. Shopware tenantSubdomain match
  {
    const { restore } = withFakeDb({
      shops: [
        { shopId: 22, "shopware": { tenantSubdomain: "demoshop", tenantId: "tid-9" }, integrationProvider: "shopware" },
      ],
    });
    try {
      const r = await findShopBySmsId("demoshop", { isPlatformAdmin: true });
      ok("shopware subdomain resolves", r?.mosShopId === 22);
      ok("shopware provider preserved", r?.provider === "shopware");
    } finally {
      restore();
    }
  }

  // 5. Autoflow domain-with-suffix match
  {
    const { restore } = withFakeDb({
      shops: [
        { shopId: 33, "autoflow": { domain: "myshop.autotext.me" }, integrationProvider: "autoflow" },
      ],
    });
    try {
      const r = await findShopBySmsId("myshop", { isPlatformAdmin: true });
      ok("autoflow domain (with .autotext.me suffix) resolves", r?.mosShopId === 33);
      ok("autoflow provider preserved", r?.provider === "autoflow");
    } finally {
      restore();
    }
  }

  // 5b. Legacy top-level autoflowDomain match (legacy PHP AutoFlow shops, e.g.
  //     Harrell's NC87 → harrells-nc87.autotext.me) — these store the AutoFlow
  //     link in the flat `autoflowDomain` field, not nested `autoflow.*`.
  {
    const { restore } = withFakeDb({
      shops: [
        { shopId: 29, autoflowDomain: "harrells-nc87.autotext.me", "protractor": { connectionId: "harrells-pt" }, integrationProvider: "protractor" },
      ],
    });
    try {
      const r = await findShopBySmsId("harrells-nc87", { isPlatformAdmin: true });
      ok("legacy autoflowDomain (with .autotext.me suffix) resolves", r?.mosShopId === 29);
      ok("legacy autoflowDomain shop keeps its write provider (protractor)", r?.provider === "protractor");
    } finally {
      restore();
    }
  }

  // 6. Provider inference when integrationProvider is missing
  {
    const { restore } = withFakeDb({
      shops: [
        { shopId: 51, "protractor": { connectionId: "no-provider-stamp" } },
      ],
    });
    try {
      const r = await findShopBySmsId("no-provider-stamp", { isPlatformAdmin: true });
      ok("provider inferred from doc shape when not stamped", r?.provider === "protractor");
    } finally {
      restore();
    }
  }

  // 7. Non-admin scoped to userShopIds is denied for unowned shop
  {
    const { restore } = withFakeDb({
      shops: [
        { shopId: 99, "tekmetric": { shopId: 200 }, integrationProvider: "tekmetric" },
      ],
    });
    try {
      const r = await findShopBySmsId("200", { isPlatformAdmin: false, userShopIds: [42] });
      ok("non-admin without ownership returns null", r === null);
    } finally {
      restore();
    }
  }

  // 8. Non-admin with ownership passes
  {
    const { restore } = withFakeDb({
      shops: [
        { shopId: 42, "tekmetric": { shopId: 200 }, integrationProvider: "tekmetric" },
      ],
    });
    try {
      const r = await findShopBySmsId("200", { isPlatformAdmin: false, userShopIds: [42] });
      ok("non-admin with ownership resolves", r?.mosShopId === 42);
    } finally {
      restore();
    }
  }

  // 9. Shopware fallback: single tenantId candidate auto-associates
  {
    const { fake, restore } = withFakeDb({
      shops: [
        { shopId: 60, "shopware": { tenantId: "tid-only" }, integrationProvider: "shopware" },
      ],
    });
    try {
      const r = await findShopBySmsId("brand-new-subdomain", {
        isPlatformAdmin: true,
        providerHint: "shopware",
      });
      ok("shopware fallback finds the lone tenantId candidate", r?.mosShopId === 60);
      // The route persists tenantSubdomain back via a dot-path $set; assert the
      // updateOne call was issued against the shops collection so future
      // lookups would short-circuit through the primary $or (rather than
      // re-falling-back). Verifying the deep-set effect would require deeper
      // mongo emulation than the fake supports.
      const persistOp = fake.ops.find(
        (o) =>
          o.op === "updateOne" &&
          (o as any).collection === "shops" &&
          JSON.stringify((o as any).update).includes("tenantSubdomain"),
      );
      ok(
        "shopware fallback writes tenantSubdomain back to the shop doc",
        !!persistOp,
      );
    } finally {
      restore();
    }
  }

  // 10. Shopware fallback: ambiguous (>1 candidates) → null (must not pick one)
  {
    const { restore } = withFakeDb({
      shops: [
        { shopId: 61, "shopware": { tenantId: "tid-a" }, integrationProvider: "shopware" },
        { shopId: 62, "shopware": { tenantId: "tid-b" }, integrationProvider: "shopware" },
      ],
    });
    try {
      const r = await findShopBySmsId("ambiguous", {
        isPlatformAdmin: true,
        providerHint: "shopware",
      });
      ok("shopware fallback refuses to guess when >1 candidates exist", r === null);
    } finally {
      restore();
    }
  }

  // 11. Empty world → null (no leak, no throw)
  {
    const { restore } = withFakeDb({ shops: [] });
    try {
      const r = await findShopBySmsId("nothing-here", { isPlatformAdmin: true });
      ok("empty shops collection returns null", r === null);
    } finally {
      restore();
    }
  }

  // 12. Shopmonkey direct match on a stored locationId (primary $or path)
  {
    const { restore } = withFakeDb({
      shops: [
        { shopId: 70, shopmonkey: { apiKey: "k", locationId: "6528009a97f3040022a9b62e", companyId: "comp-1" }, integrationProvider: "shopmonkey" },
      ],
    });
    try {
      const r = await findShopBySmsId("6528009a97f3040022a9b62e", { isPlatformAdmin: true, providerHint: "shopmonkey" });
      ok("shopmonkey stored locationId resolves directly", r?.mosShopId === 70);
      ok("shopmonkey provider preserved", r?.provider === "shopmonkey");
    } finally {
      restore();
    }
  }

  // 13. Shopmonkey self-heal: keyed-but-unidded shop resolves after discovery
  //     (mirrors Mason on Pro Transmission of Athens — API key present, ids null).
  {
    const onPageId = "6528009a97f3040022a9b62e";
    let discoverCalls = 0;
    const { fake, restore } = withFakeDb(
      {
        shops: [
          { shopId: 195, shopmonkey: { apiKey: "key-195", locationId: null, companyId: null }, integrationProvider: "shopmonkey" },
        ],
      },
      async (apiKey) => {
        discoverCalls += 1;
        return apiKey === "key-195"
          ? { companyId: "company-195", locationId: onPageId }
          : { companyId: null, locationId: null };
      },
    );
    try {
      const r = await findShopBySmsId(onPageId, { isPlatformAdmin: true, providerHint: "shopmonkey" });
      ok("shopmonkey self-heal resolves keyed-but-unidded shop", r?.mosShopId === 195);
      ok("shopmonkey self-heal called the discovery helper", discoverCalls === 1);
      const persistOp = fake.ops.find(
        (o) =>
          o.op === "updateOne" &&
          (o as any).collection === "shops" &&
          JSON.stringify((o as any).update).includes("shopmonkey.locationId"),
      );
      ok("shopmonkey self-heal persists discovered ids back to the shop doc", !!persistOp);
    } finally {
      restore();
    }
  }

  // 14. Shopmonkey self-heal: a user with TWO keyed shops resolves to the
  //     correct one — each key reports only its own id.
  {
    const aLineId = "1111111111111111111111aa";
    const proTransId = "6528009a97f3040022a9b62e";
    const { restore } = withFakeDb(
      {
        shops: [
          { shopId: 165, shopmonkey: { apiKey: "key-aline", locationId: null, companyId: null }, integrationProvider: "shopmonkey" },
          { shopId: 195, shopmonkey: { apiKey: "key-protrans", locationId: null, companyId: null }, integrationProvider: "shopmonkey" },
        ],
      },
      async (apiKey) =>
        apiKey === "key-aline"
          ? { companyId: "co-aline", locationId: aLineId }
          : { companyId: "co-protrans", locationId: proTransId },
    );
    try {
      const r = await findShopBySmsId(proTransId, { isPlatformAdmin: false, userShopIds: [165, 195] });
      ok("shopmonkey self-heal picks the shop whose key matches the on-page id", r?.mosShopId === 195);
    } finally {
      restore();
    }
  }

  // 15. Shopmonkey self-heal: genuine no-match still fails closed (null).
  {
    const { restore } = withFakeDb(
      {
        shops: [
          { shopId: 165, shopmonkey: { apiKey: "key-aline", locationId: null, companyId: null }, integrationProvider: "shopmonkey" },
        ],
      },
      async () => ({ companyId: "co-aline", locationId: "1111111111111111111111aa" }),
    );
    try {
      const r = await findShopBySmsId("9999999999999999999999ff", { isPlatformAdmin: true, providerHint: "shopmonkey" });
      ok("shopmonkey self-heal returns null when no key's id matches", r === null);
    } finally {
      restore();
    }
  }

  // 16. Shopmonkey self-heal does NOT fire for already-idded shops (bounded):
  //     a shop with ids stored is matched by the primary $or, and the discovery
  //     helper is never invoked.
  {
    let discoverCalls = 0;
    const { restore } = withFakeDb(
      {
        shops: [
          { shopId: 70, shopmonkey: { apiKey: "k", locationId: "6528009a97f3040022a9b62e", companyId: "comp-1" }, integrationProvider: "shopmonkey" },
        ],
      },
      async () => {
        discoverCalls += 1;
        return { companyId: null, locationId: null };
      },
    );
    try {
      const r = await findShopBySmsId("6528009a97f3040022a9b62e", { isPlatformAdmin: true, providerHint: "shopmonkey" });
      ok("already-idded shopmonkey shop resolves without discovery", r?.mosShopId === 70 && discoverCalls === 0);
    } finally {
      restore();
    }
  }

  // 17. AutoFlow v4 shop NUMBER stored in autoflow.shopNumbers resolves (task #884)
  {
    const { restore } = withFakeDb({
      shops: [
        { shopId: 33, autoflow: { domain: "myshop.autotext.me", shopNumbers: ["1360"] }, integrationProvider: "autoflow" },
      ],
    });
    try {
      const r = await findShopBySmsId("1360", { isPlatformAdmin: true, providerHint: "autoflow" });
      ok("autoflow v4 number in shopNumbers resolves", r?.mosShopId === 33);
    } finally {
      restore();
    }
  }

  // 18. AutoFlow fallback: single candidate auto-learns the v4 number
  {
    const { fake, restore } = withFakeDb({
      shops: [
        { shopId: 34, autoflow: { domain: "solo.autotext.me" }, integrationProvider: "autoflow" },
      ],
    });
    try {
      const r = await findShopBySmsId("7777", { isPlatformAdmin: false, userShopIds: [34], providerHint: "autoflow" });
      ok("autoflow fallback resolves the lone candidate", r?.mosShopId === 34);
      const persistOp = fake.ops.find(
        (o) =>
          o.op === "updateOne" &&
          (o as any).collection === "shops" &&
          JSON.stringify((o as any).update).includes("shopNumbers"),
      );
      ok("autoflow fallback learns the number into autoflow.shopNumbers", !!persistOp);
    } finally {
      restore();
    }
  }

  // 19. AutoFlow fallback: ambiguous (>1 candidates) → fail closed AND record
  //     the unresolved number for the platform-admin attach UI (task #884).
  {
    const { fake, restore } = withFakeDb({
      shops: [
        { shopId: 35, autoflow: { domain: "a.autotext.me" }, integrationProvider: "autoflow" },
        { shopId: 36, autoflow: { domain: "b.autotext.me" }, integrationProvider: "autoflow" },
      ],
      autoflow_unresolved_numbers: [],
    });
    try {
      const r = await findShopBySmsId("1360", { isPlatformAdmin: true, providerHint: "autoflow" });
      ok("autoflow ambiguous fallback fails closed (null, never guesses)", r === null);
      const recordOp = fake.ops.find(
        (o) =>
          o.op === "updateOne" &&
          (o as any).collection === "autoflow_unresolved_numbers",
      );
      ok("ambiguous autoflow number recorded as unresolved", !!recordOp);
      ok(
        "unresolved record is an upsert keyed by the number",
        !!recordOp && JSON.stringify((recordOp as any).filter).includes("1360"),
      );
    } finally {
      restore();
    }
  }

  // 20. AutoFlow zero-candidate miss (number seen but NO autoflow shops in
  //     scope) is also recorded — the platform admin needs to see these too.
  {
    const { fake, restore } = withFakeDb({
      shops: [],
      autoflow_unresolved_numbers: [],
    });
    try {
      const r = await findShopBySmsId("9999", { isPlatformAdmin: true, providerHint: "autoflow" });
      ok("autoflow zero-candidate miss returns null", r === null);
      const recordOp = fake.ops.find(
        (o) =>
          o.op === "updateOne" &&
          (o as any).collection === "autoflow_unresolved_numbers",
      );
      ok("zero-candidate miss recorded as unresolved", !!recordOp);
    } finally {
      restore();
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} smoke check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll smoke checks passed.");
}

run().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
