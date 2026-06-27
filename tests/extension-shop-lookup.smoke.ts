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

function withFakeDb(seed: Record<string, any[]>) {
  const fake = makeFakeDb(seed);
  const original = __deps.getDb;
  __deps.getDb = async () => fake.db as any;
  return {
    fake,
    restore: () => {
      __deps.getDb = original;
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
