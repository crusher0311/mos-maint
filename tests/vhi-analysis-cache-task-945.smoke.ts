/**
 * Smoke test for task #945 hot-path fixes.
 *
 * Run: `npx tsx tests/vhi-analysis-cache-task-945.smoke.ts`
 *
 * 1. Tenant safety: `getVhiFromAnalysisCache` must never return another
 *    shop's vehicle metadata / customerName when the same VIN exists under
 *    multiple shops — the `vehicles` lookup must stay shop-scoped (String +
 *    Number shopId variants) and use a projection, not a full-doc fetch.
 * 2. Index-eligible make/model matching: the caseVariants helpers must
 *    produce exact / anchored-case-sensitive shapes (no `$options: "i"`).
 */

import { getVhiFromAnalysisCache } from "../lib/vhi-score";
import { caseVariants, exactCaseVariants, prefixCaseVariants } from "../lib/dashboard-search";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const VIN = "1FTFW1ET5DFC12345";
const SHOP_A = 111;
const SHOP_B = 222;

// Two shops share the same VIN with different customers.
const vehiclesDocs = [
  { vin: VIN, shopId: SHOP_A, year: 2020, make: "Ford", model: "F-150", engine: "3.5L V6", customerName: "Alice ShopA" },
  { vin: VIN, shopId: String(SHOP_B), year: 2020, make: "Ford", model: "F-150", engine: "3.5L V6", customerName: "Bob ShopB" },
];

function matchesShopFilter(doc: any, filter: any): boolean {
  if (doc.vin !== filter.vin) return false;
  const shopCond = filter.shopId;
  if (shopCond == null) return true; // unscoped — matches everything (the bug)
  if (shopCond.$in) return shopCond.$in.some((v: any) => v === doc.shopId);
  return doc.shopId === shopCond;
}

let capturedVehiclesFilter: any = null;
let capturedVehiclesOptions: any = null;

const fakeDb: any = {
  collection(name: string) {
    if (name === "maintenance_analysis_cache") {
      return {
        findOne: async () => ({
          vin: VIN,
          shopId: SHOP_A,
          analyzedAt: new Date(),
          mileageAtAnalysis: 50000,
          recommendations: [
            { service: "Oil Change", serviceKey: "engine_oil", status: "overdue", category: "Engine" },
          ],
        }),
      };
    }
    if (name === "vehicles") {
      return {
        findOne: async (filter: any, options: any) => {
          capturedVehiclesFilter = filter;
          capturedVehiclesOptions = options;
          return vehiclesDocs.find((d) => matchesShopFilter(d, filter)) ?? null;
        },
      };
    }
    throw new Error(`unexpected collection ${name}`);
  },
};

async function main() {
  console.log("VHI analysis-cache tenant scoping (task #945)");

  const resA = await getVhiFromAnalysisCache(fakeDb, VIN, SHOP_A);
  ok("returns a result from analysis cache", !!resA);
  ok(
    "vehicles lookup is shop-scoped (never VIN-only)",
    !!capturedVehiclesFilter?.shopId,
    JSON.stringify(capturedVehiclesFilter),
  );
  ok(
    "shopId matched as both String and Number variants",
    Array.isArray(capturedVehiclesFilter?.shopId?.$in) &&
      capturedVehiclesFilter.shopId.$in.includes(String(SHOP_A)) &&
      capturedVehiclesFilter.shopId.$in.includes(Number(SHOP_A)),
  );
  ok(
    "vehicles lookup uses a field projection (no full-doc fetch)",
    !!capturedVehiclesOptions?.projection &&
      capturedVehiclesOptions.projection.customerName === 1 &&
      !("lines" in capturedVehiclesOptions.projection),
  );
  ok("shop A sees its own customer", resA?.customerName === "Alice ShopA", String(resA?.customerName));
  ok(
    "shop A never sees shop B's customer",
    resA?.customerName !== "Bob ShopB",
  );

  // Shop B (legacy String shopId row) still resolves its own customer.
  const resB = await getVhiFromAnalysisCache(fakeDb, VIN, SHOP_B);
  ok("shop B (legacy String shopId row) sees its own customer", resB?.customerName === "Bob ShopB", String(resB?.customerName));

  console.log("\nIndex-eligible case-variant helpers (task #945)");
  const variants = caseVariants("mercedes-benz");
  ok(
    "caseVariants covers raw/UPPER/lower/Title",
    variants.includes("mercedes-benz") &&
      variants.includes("MERCEDES-BENZ") &&
      variants.includes("Mercedes-Benz"),
    JSON.stringify(variants),
  );
  const exact = exactCaseVariants("Ford");
  ok("exactCaseVariants is a plain $in of strings (index-eligible)",
    Array.isArray(exact.$in) && exact.$in.every((v) => typeof v === "string"));
  const prefix = prefixCaseVariants("Mercedes");
  ok(
    "prefixCaseVariants regexes are anchored and case-SENSITIVE",
    prefix.$in.every((r) => r instanceof RegExp && r.source.startsWith("^") && !r.flags.includes("i")),
  );
  ok("prefix variant still matches longer stored value", prefix.$in.some((r) => r.test("Mercedes-Benz")));
  ok("prefix variant matches UPPER stored value", prefix.$in.some((r) => r.test("MERCEDES-BENZ")));

  if (failed > 0) {
    console.error(`\n${failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\nAll assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
