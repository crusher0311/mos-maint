/**
 * Smoke test for the customer-name fallback chain in
 * `lib/plan-build/customer-name.ts`.
 *
 * Run: `npx tsx tests/plan-build-customer-name.smoke.ts`
 *
 * The plan greets the customer by name on the cover. The route resolves that
 * name by trying four sources in priority order:
 *
 *   1. Tekmetric `tekmetric_work_orders` (skipping the literal sentinel
 *      `"Unknown Customer"`)
 *   2. Protractor vehicle record (`CustomerName`, else `FirstName LastName`)
 *   3. Shop-Ware `cached_work_orders`
 *   4. The `vehicles` collection
 *
 * A silent regression — accepting the "Unknown Customer" sentinel from
 * Tekmetric, dropping the Protractor branch, letting an empty string
 * through Shop-Ware, etc. — would surface the WRONG name on the plan.
 *
 * This test exercises every priority transition and the all-missing case.
 */

import {
  resolveCustomerName,
  TEKMETRIC_UNKNOWN_CUSTOMER_SENTINEL,
} from "../lib/plan-build/customer-name";

let failed = 0;

function ok(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  \u2713 ${name}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ""}`);
  }
}

async function main() {
  console.log("Plan-build customer-name fallback smoke checks");

  // ----------------- 1. Tekmetric wins when it has a real name -----------------
  {
    const resolved = resolveCustomerName({
      tekmetricWorkOrder: { customerName: "Jane Tekmetric" },
      protractorVehicle: { CustomerName: "Phil Protractor" },
      shopWareWorkOrder: { customerName: "Sam ShopWare" },
      vehicleDoc: { customerName: "Vera Vehicles" },
    });
    ok(
      "Tekmetric wins when its customerName is real",
      resolved === "Jane Tekmetric",
      `got=${resolved}`,
    );
  }

  // ----------------- 2. Tekmetric "Unknown Customer" sentinel falls through -----------------
  {
    const resolved = resolveCustomerName({
      tekmetricWorkOrder: { customerName: TEKMETRIC_UNKNOWN_CUSTOMER_SENTINEL },
      protractorVehicle: { CustomerName: "Phil Protractor" },
      shopWareWorkOrder: { customerName: "Sam ShopWare" },
      vehicleDoc: { customerName: "Vera Vehicles" },
    });
    ok(
      "Tekmetric \"Unknown Customer\" sentinel is rejected — Protractor wins",
      resolved === "Phil Protractor",
      `got=${resolved}`,
    );
  }
  {
    // Defense in depth: even if a code path passed the literal string we'd
    // never want to greet the customer with this sentinel.
    const resolved = resolveCustomerName({
      tekmetricWorkOrder: { customerName: "Unknown Customer" },
    });
    ok(
      "Tekmetric \"Unknown Customer\" alone resolves to null (no greeting)",
      resolved === null,
      `got=${resolved}`,
    );
  }

  // ----------------- 3. Tekmetric null/missing falls through to Protractor -----------------
  {
    const resolved = resolveCustomerName({
      tekmetricWorkOrder: { customerName: null },
      protractorVehicle: { CustomerName: "Phil Protractor" },
    });
    ok(
      "Null Tekmetric customerName falls through to Protractor",
      resolved === "Phil Protractor",
      `got=${resolved}`,
    );
  }
  {
    const resolved = resolveCustomerName({
      tekmetricWorkOrder: null,
      protractorVehicle: { CustomerName: "Phil Protractor" },
    });
    ok(
      "Missing Tekmetric WO falls through to Protractor",
      resolved === "Phil Protractor",
      `got=${resolved}`,
    );
  }
  {
    // Empty Tekmetric customerName is treated as missing, not greeted.
    const resolved = resolveCustomerName({
      tekmetricWorkOrder: { customerName: "" },
      protractorVehicle: { CustomerName: "Phil Protractor" },
    });
    ok(
      "Empty-string Tekmetric customerName falls through to Protractor",
      resolved === "Phil Protractor",
      `got=${resolved}`,
    );
  }

  // ----------------- 4. Protractor first/last composition -----------------
  {
    const resolved = resolveCustomerName({
      protractorVehicle: { FirstName: "Phil", LastName: "Protractor" },
    });
    ok(
      "Protractor composes FirstName + LastName when CustomerName is absent",
      resolved === "Phil Protractor",
      `got=${resolved}`,
    );
  }
  {
    // FirstName-only — no leading/trailing whitespace from the missing half.
    const resolved = resolveCustomerName({
      protractorVehicle: { FirstName: "Phil", LastName: null },
    });
    ok(
      "Protractor handles a missing LastName without trailing whitespace",
      resolved === "Phil",
      `got=${JSON.stringify(resolved)}`,
    );
  }
  {
    // Empty-string CustomerName must NOT be returned — the join fallback
    // should kick in instead.
    const resolved = resolveCustomerName({
      protractorVehicle: { CustomerName: "", FirstName: "Phil", LastName: "Protractor" },
    });
    ok(
      "Empty Protractor CustomerName falls through to FirstName + LastName",
      resolved === "Phil Protractor",
      `got=${resolved}`,
    );
  }
  {
    // Empty Protractor entirely → must NOT short-circuit; fall through to
    // Shop-Ware.
    const resolved = resolveCustomerName({
      protractorVehicle: { CustomerName: null, FirstName: null, LastName: null },
      shopWareWorkOrder: { customerName: "Sam ShopWare" },
    });
    ok(
      "Protractor with all-empty fields falls through to Shop-Ware",
      resolved === "Sam ShopWare",
      `got=${resolved}`,
    );
  }

  // ----------------- 5. Shop-Ware is consulted before vehicles -----------------
  {
    const resolved = resolveCustomerName({
      tekmetricWorkOrder: { customerName: TEKMETRIC_UNKNOWN_CUSTOMER_SENTINEL },
      protractorVehicle: null,
      shopWareWorkOrder: { customerName: "Sam ShopWare" },
      vehicleDoc: { customerName: "Vera Vehicles" },
    });
    ok(
      "Shop-Ware wins over the vehicles collection",
      resolved === "Sam ShopWare",
      `got=${resolved}`,
    );
  }
  {
    const resolved = resolveCustomerName({
      shopWareWorkOrder: { customerName: "" },
      vehicleDoc: { customerName: "Vera Vehicles" },
    });
    ok(
      "Empty Shop-Ware customerName falls through to vehicles",
      resolved === "Vera Vehicles",
      `got=${resolved}`,
    );
  }

  // ----------------- 6. Vehicles collection is the final fallback -----------------
  {
    const resolved = resolveCustomerName({
      tekmetricWorkOrder: null,
      protractorVehicle: null,
      shopWareWorkOrder: null,
      vehicleDoc: { customerName: "Vera Vehicles" },
    });
    ok(
      "Vehicles collection is consulted when the first three sources miss",
      resolved === "Vera Vehicles",
      `got=${resolved}`,
    );
  }

  // ----------------- 7. All four sources missing → null -----------------
  {
    const resolved = resolveCustomerName({});
    ok(
      "Empty input resolves to null (no greeting, never a wrong name)",
      resolved === null,
      `got=${resolved}`,
    );
  }
  {
    const resolved = resolveCustomerName({
      tekmetricWorkOrder: null,
      protractorVehicle: null,
      shopWareWorkOrder: null,
      vehicleDoc: null,
    });
    ok(
      "All-null inputs resolve to null",
      resolved === null,
      `got=${resolved}`,
    );
  }
  {
    const resolved = resolveCustomerName({
      tekmetricWorkOrder: { customerName: TEKMETRIC_UNKNOWN_CUSTOMER_SENTINEL },
      protractorVehicle: { CustomerName: "", FirstName: "", LastName: "" },
      shopWareWorkOrder: { customerName: null },
      vehicleDoc: { customerName: "" },
    });
    ok(
      "All four sources empty/sentinel-only resolve to null",
      resolved === null,
      `got=${resolved}`,
    );
  }

  if (failed === 0) {
    console.log("\nAll plan-build customer-name smoke checks passed.");
    process.exit(0);
  } else {
    console.error(`\n${failed} plan-build customer-name smoke check(s) failed.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nplan-build customer-name smoke crashed:", err);
  process.exit(1);
});
