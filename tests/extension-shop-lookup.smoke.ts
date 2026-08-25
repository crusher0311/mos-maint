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

import {
  __deps,
  findShopBySmsId,
  findShopBySmsIdDetailed,
} from "../lib/extension-shop-lookup";
import {
  acquireAutoflowAliasClaim,
  AutoflowAtomicClaimConflictError,
  claimsBlockingAutoflowAttachment,
  findAutoflowIdentifierConflicts,
} from "../lib/autoflow-identity";
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
  const originalGetMongoClient = __deps.getMongoClient;
  const originalDiscover = __deps.discoverShopmonkeyIds;
  __deps.getDb = async () => fake.db as any;
  __deps.getMongoClient = async () => null as any;
  if (discover) __deps.discoverShopmonkeyIds = discover;
  return {
    fake,
    restore: () => {
      __deps.getDb = originalGetDb;
      __deps.getMongoClient = originalGetMongoClient;
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

  // 21. Production-shaped Harrell's collision: its canonical legacy domain
  //     wins globally over polluted learned aliases on CAR Experts and Big O.
  //     The sticker route consumes this exact shopDoc, so pin its branding and
  //     appointment destination as well as its MOS shop id.
  {
    const { restore } = withFakeDb({
      shops: [
        {
          shopId: 29,
          name: "Harrell's Tire and Auto",
          autoflowDomain: "harrells-nc87.autotext.me",
          integrationProvider: "protractor",
          protractor: { connectionId: "harrells-pt" },
          stickerConfig: {
            logo: "harrells-logo",
            phone: "910-555-0029",
            tagline: "Harrell's Tire and Auto",
            appointmentUrl: "https://harrells.example/appointments",
          },
        },
        {
          shopId: 81,
          name: "CAR Experts",
          autoflow: { domain: "car-experts.autotext.me", shopNumbers: ["harrells-nc87"] },
          stickerConfig: {
            logo: "car-experts-logo",
            appointmentUrl: "https://car-experts.example",
          },
        },
        {
          shopId: 82,
          name: "Big O Tires",
          autoflow: { domain: "big-o.autotext.me", shopNumbers: ["harrells-nc87"] },
          stickerConfig: {
            logo: "big-o-logo",
            appointmentUrl: "https://big-o.example",
          },
        },
      ],
    });
    try {
      const r = await findShopBySmsId("harrells-nc87", {
        isPlatformAdmin: true,
        providerHint: "autoflow",
      });
      ok("canonical Harrell's domain wins over two polluted aliases", r?.mosShopId === 29);
      ok(
        "sticker lookup receives Harrell's branding",
        r?.shopDoc?.stickerConfig?.logo === "harrells-logo"
          && r?.shopDoc?.stickerConfig?.phone === "910-555-0029"
          && r?.shopDoc?.stickerConfig?.tagline === "Harrell's Tire and Auto",
      );
      ok(
        "sticker lookup receives Harrell's appointment destination",
        r?.shopDoc?.stickerConfig?.appointmentUrl === "https://harrells.example/appointments",
      );
    } finally {
      restore();
    }
  }

  // 22. Access is applied after global canonical resolution. A user who can
  //     access the polluted alias owner but not Harrell's must be denied rather
  //     than silently falling through to the wrong shop.
  {
    const { fake, restore } = withFakeDb({
      shops: [
        {
          shopId: 29,
          name: "Harrell's Tire and Auto",
          autoflowDomain: "harrells-nc87.autotext.me",
        },
        {
          shopId: 81,
          name: "CAR Experts",
          autoflow: { domain: "car-experts.autotext.me", shopNumbers: ["harrells-nc87"] },
        },
      ],
    });
    try {
      const outcome = await findShopBySmsIdDetailed("harrells-nc87", {
        isPlatformAdmin: false,
        userShopIds: [81],
        providerHint: "autoflow",
      });
      ok("inaccessible canonical owner fails closed", outcome.status === "access_denied");
      ok(
        "inaccessible canonical owner never triggers alias learning",
        !fake.ops.some(
          (op) =>
            op.op === "updateOne"
            && (op as any).collection === "shops"
            && JSON.stringify((op as any).update).includes("shopNumbers"),
        ),
      );
    } finally {
      restore();
    }
  }

  // 23. Duplicate learned aliases with no canonical owner return a clear
  //     conflict outcome and are recorded for operator repair.
  {
    const { fake, restore } = withFakeDb({
      shops: [
        { shopId: 91, name: "Alias A", autoflow: { domain: "a.autotext.me", shopNumbers: ["2468"] } },
        { shopId: 92, name: "Alias B", autoflow: { domain: "b.autotext.me", shopNumbers: ["2468"] } },
      ],
      autoflow_unresolved_numbers: [],
    });
    try {
      const outcome = await findShopBySmsIdDetailed("2468", {
        isPlatformAdmin: true,
        providerHint: "autoflow",
      });
      ok(
        "duplicate learned aliases return an alias conflict",
        outcome.status === "conflict"
          && outcome.conflictType === "alias"
          && outcome.shopIds.length === 2,
      );
      const unresolvedWrite = fake.ops.find(
        (op) => op.op === "updateOne" && (op as any).collection === "autoflow_unresolved_numbers",
      ) as any;
      ok(
        "duplicate alias conflict records a clear reason",
        unresolvedWrite?.update?.$set?.reason === "duplicate_alias",
      );
    } finally {
      restore();
    }
  }

  // 24. Unknown v3-looking slugs are never auto-learned into the user's only
  //     AutoFlow shop. Only numeric v4 identifiers use that fallback.
  {
    const { fake, restore } = withFakeDb({
      shops: [
        { shopId: 93, name: "Only Shop", autoflow: { domain: "only.autotext.me" } },
      ],
      autoflow_unresolved_numbers: [],
    });
    try {
      const outcome = await findShopBySmsIdDetailed("unknown-v3-slug", {
        isPlatformAdmin: false,
        userShopIds: [93],
        providerHint: "autoflow",
      });
      ok("unknown non-numeric AutoFlow identifier stays unresolved", outcome.status === "not_found");
      ok(
        "unknown non-numeric AutoFlow identifier is not learned",
        !fake.ops.some(
          (op) =>
            op.op === "updateOne"
            && (op as any).collection === "shops"
            && JSON.stringify((op as any).update).includes("shopNumbers"),
        ),
      );
    } finally {
      restore();
    }
  }

  // 25. Platform-admin attachment uses the same global claim model: canonical
  //     ownership and learned aliases on another shop both block attachment.
  {
    const shops = [
      { shopId: 29, name: "Harrell's", autoflowDomain: "harrells-nc87.autotext.me" },
      { shopId: 81, name: "CAR Experts", autoflow: { shopNumbers: ["7777"] } },
      { shopId: 99, name: "Target", autoflow: { domain: "target.autotext.me" } },
    ];
    const canonicalBlockers = claimsBlockingAutoflowAttachment(
      shops,
      "harrells-nc87",
      99,
    );
    const aliasBlockers = claimsBlockingAutoflowAttachment(shops, "7777", 99);
    ok(
      "admin attachment rejects another shop's canonical identity",
      canonicalBlockers.length === 1
        && canonicalBlockers[0].shopId === 29
        && canonicalBlockers[0].claimType === "canonical",
    );
    ok(
      "admin attachment rejects another shop's learned alias",
      aliasBlockers.length === 1
        && aliasBlockers[0].shopId === 81
        && aliasBlockers[0].claimType === "alias",
    );

    const conflicts = findAutoflowIdentifierConflicts([
      ...shops,
      { shopId: 82, name: "Big O", autoflow: { shopNumbers: ["harrells-nc87"] } },
    ]);
    ok(
      "admin conflict inventory surfaces canonical-versus-alias pollution",
      conflicts.some(
        (item) =>
          item.identifier === "harrells-nc87"
          && item.reason === "canonical_alias_collision",
      ),
    );
  }

  // 26. A non-admin with no assigned shops is never treated as globally
  //     authorized, for either an existing canonical owner or v4 auto-learning.
  {
    const { fake, restore } = withFakeDb({
      shops: [
        {
          shopId: 29,
          name: "Harrell's",
          autoflowDomain: "harrells-nc87.autotext.me",
        },
      ],
    });
    try {
      const canonical = await findShopBySmsIdDetailed("harrells-nc87", {
        isPlatformAdmin: false,
        userShopIds: [],
        providerHint: "autoflow",
      });
      const unknownV4 = await findShopBySmsIdDetailed("8642", {
        isPlatformAdmin: false,
        userShopIds: [],
        providerHint: "autoflow",
      });
      ok("empty non-admin scope denies a canonical AutoFlow owner", canonical.status === "access_denied");
      ok("empty non-admin scope denies unknown v4 learning", unknownV4.status === "access_denied");
      ok(
        "empty non-admin scope performs no alias write",
        !fake.ops.some(
          (op) =>
            op.op === "updateOne"
            && (op as any).collection === "shops"
            && JSON.stringify((op as any).update).includes("shopNumbers"),
        ),
      );
    } finally {
      restore();
    }
  }

  // 27. Mongo retrieval uses case-insensitive collation, then normalizes the
  //     claim, so mixed-case legacy domains cannot evade canonical precedence.
  {
    const { restore } = withFakeDb({
      shops: [
        {
          shopId: 29,
          autoflowDomain: "Harrells-NC87.AutoText.Me",
          integrationProvider: "protractor",
        },
        {
          shopId: 81,
          autoflow: { shopNumbers: ["HARRELLS-NC87"] },
        },
      ],
    });
    try {
      const result = await findShopBySmsId("harrells-nc87", {
        isPlatformAdmin: true,
        providerHint: "AuToFlOw",
      });
      ok("mixed-case canonical identity still wins", result?.mosShopId === 29);
    } finally {
      restore();
    }
  }

  // 28. Canonical AutoFlow identity is checked even when an incorrect provider
  //     hint is supplied, preventing a spoofed hint from bypassing precedence.
  {
    const { restore } = withFakeDb({
      shops: [
        { shopId: 29, autoflowDomain: "harrells-nc87.autotext.me" },
        { shopId: 81, protractor: { connectionId: "harrells-nc87" } },
      ],
    });
    try {
      const result = await findShopBySmsId("harrells-nc87", {
        isPlatformAdmin: true,
        providerHint: "tekmetric",
      });
      ok("incorrect provider hint cannot bypass canonical AutoFlow owner", result?.mosShopId === 29);
    } finally {
      restore();
    }
  }

  // 29. The normalized claim registry uses Mongo's unique _id as the atomic
  //     serialization point, so concurrent owners cannot both reserve an id.
  {
    const fake = makeFakeDb({ autoflow_identifier_claims: [] });
    await acquireAutoflowAliasClaim(fake.db, "7777", 34, {
      source: "auto_learning",
    });
    let conflict: unknown = null;
    try {
      await acquireAutoflowAliasClaim(fake.db, "7777", 35, {
        source: "platform_admin",
      });
    } catch (error) {
      conflict = error;
    }
    ok(
      "atomic claim registry rejects a concurrent different owner",
      conflict instanceof AutoflowAtomicClaimConflictError
        && conflict.ownerShopId === 34,
    );
  }

  // 30. A server-issued non-AutoFlow provider is namespace-authoritative:
  //     an unrelated AutoFlow canonical with the same numeric id cannot hijack
  //     a Tekmetric sticker lookup.
  {
    const { restore } = withFakeDb({
      shops: [
        { shopId: 29, autoflow: { shopId: "1517" }, integrationProvider: "autoflow" },
        { shopId: 80, tekmetric: { shopId: 1517 }, integrationProvider: "tekmetric" },
      ],
    });
    try {
      const result = await findShopBySmsId("1517", {
        isPlatformAdmin: true,
        providerHint: "tekmetric",
        providerHintIsAuthoritative: true,
      });
      ok(
        "authoritative Tekmetric namespace ignores unrelated AutoFlow canonical collision",
        result?.mosShopId === 80 && result.provider === "tekmetric",
      );
    } finally {
      restore();
    }
  }

  // 31. In the no-session fallback used by tests, a thrown shop mutation
  //     compensates by releasing the just-created atomic reservation.
  {
    const { fake, restore } = withFakeDb({
      shops: [{ _id: "shop-34", shopId: 34, autoflow: { domain: "solo.autotext.me" } }],
      autoflow_identifier_claims: [],
    });
    const originalCollection = fake.db.collection.bind(fake.db);
    (fake.db as any).collection = (name: string) => {
      const collection = originalCollection(name) as any;
      if (name === "shops") {
        collection.updateOne = async () => {
          throw new Error("simulated shop write failure");
        };
      }
      return collection;
    };
    try {
      let thrown: unknown = null;
      try {
        await findShopBySmsIdDetailed("7777", {
          isPlatformAdmin: false,
          userShopIds: [34],
          providerHint: "autoflow",
        });
      } catch (error) {
        thrown = error;
      }
      ok(
        "auto-learning propagates a thrown shop mutation",
        thrown instanceof Error && thrown.message === "simulated shop write failure",
      );
      ok(
        "failed auto-learning releases its reservation",
        fake.collections.autoflow_identifier_claims.length === 0,
      );
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
