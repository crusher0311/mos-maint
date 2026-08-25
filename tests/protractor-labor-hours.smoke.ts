/**
 * Smoke test for Protractor labor-hours derivation (task #986).
 *
 * Run: `npx tsx tests/protractor-labor-hours.smoke.ts`
 *
 * Protractor service packages carry no package-level hours fields, so
 * mapServiceJob must fall back to summing the child labor lines' Hours (or
 * Quantity) into laborHoursBilled. Pins:
 *   - sumLaborLineHours sums only labor lines, prefers Hours over Quantity,
 *     handles both ItemCollection and bare-array shapes,
 *   - zero/no labor lines → undefined (never 0 — the PG column is nullable
 *     and 0 would read as "zero hours billed"),
 *   - mapServiceJob uses explicit package hours when present and only falls
 *     back to line hours when absent.
 */
// NOTE: core/normalized-adapter and protractor/normalized-adapter are
// mutually circular; the core module must be loaded FIRST or the protractor
// module's import of core re-enters it before ProtractorAdapter exists.
import { ProtractorAdapter } from "../lib/integrations/core/normalized-adapter";
import { sumLaborLineHours } from "../lib/integrations/protractor/normalized-adapter";

let failed = 0;
function ok(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// --- sumLaborLineHours ------------------------------------------------------

ok(
  "sums Hours across labor lines (ItemCollection shape)",
  sumLaborLineHours({
    ServicePackageLines: {
      ItemCollection: [
        { Type: "Labor", Hours: 1.5 },
        { Type: "Labor", Hours: 0.7 },
        { Type: "Material", Quantity: 4 },
      ],
    },
  }) === 2.2,
);

ok(
  "falls back to Quantity when Hours absent (bare-array shape)",
  sumLaborLineHours({
    ServicePackageLines: [
      { Type: "Labor", Quantity: 2 },
      { Type: "Part", Quantity: 1 },
    ],
  }) === 2,
);

ok(
  "non-labor-only package → undefined",
  sumLaborLineHours({
    ServicePackageLines: [{ Type: "Material", Quantity: 3 }],
  }) === undefined,
);

ok("no lines → undefined", sumLaborLineHours({}) === undefined);
ok(
  "labor lines with zero hours → undefined (0 is not a real value)",
  sumLaborLineHours({ ServicePackageLines: [{ Type: "Labor", Hours: 0 }] }) === undefined,
);
ok(
  "rounds to 2 decimals",
  sumLaborLineHours({
    ServicePackageLines: [
      { Type: "Labor", Hours: 0.1 },
      { Type: "Labor", Hours: 0.2 },
    ],
  }) === 0.3,
);
ok(
  "matches LineType field too",
  sumLaborLineHours({ ServicePackageLines: [{ LineType: "labor", Hours: 1 }] }) === 1,
);

// --- mapServiceJob wiring ----------------------------------------------------

const adapter = new ProtractorAdapter();

const mappedInvoice = adapter.mapWorkOrder(235, {
  ID: "1f2592a3-f7cd-4aef-9e7d-43ca3f3bd997",
  WorkOrderNumber: 709007422,
  InvoiceNumber: 0,
  WorkflowStage: "Invoice",
});
ok(
  "mapWorkOrder prefers the human-facing WorkOrderNumber over the invoice GUID",
  mappedInvoice.workOrderNumber === "709007422",
  `got ${mappedInvoice.workOrderNumber}`,
);
ok(
  "getSourceIds preserves the human-facing WorkOrderNumber",
  adapter
    .getSourceIds({
      ID: "1f2592a3-f7cd-4aef-9e7d-43ca3f3bd997",
      WorkOrderNumber: 709007422,
      InvoiceNumber: 0,
    })
    .some(
      (id) =>
        id.idType === "work_order_number" &&
        id.idValue === "709007422" &&
        id.isPrimary === false,
    ),
);

const derived = adapter.mapServiceJob(66, "wo-1", {
  ID: "sp-1",
  ServicePackageHeader: { Title: "Water Pump" },
  ServicePackageLines: {
    ItemCollection: [
      { Type: "Labor", Hours: 3.4 },
      { Type: "Material", Quantity: 1 },
    ],
  },
});
ok(
  "mapServiceJob derives laborHoursBilled from labor lines",
  derived.laborHoursBilled === 3.4,
  `got ${derived.laborHoursBilled}`,
);

const explicit = adapter.mapServiceJob(66, "wo-1", {
  ID: "sp-2",
  BilledHours: 2.0,
  ServicePackageLines: { ItemCollection: [{ Type: "Labor", Hours: 9 }] },
});
ok(
  "explicit package BilledHours wins over line sum",
  explicit.laborHoursBilled === 2.0,
  `got ${explicit.laborHoursBilled}`,
);

const none = adapter.mapServiceJob(66, "wo-1", {
  ID: "sp-3",
  ServicePackageLines: { ItemCollection: [{ Type: "Material", Quantity: 2 }] },
});
ok(
  "no hours anywhere → laborHoursBilled stays undefined (not 0)",
  none.laborHoursBilled === undefined,
  `got ${none.laborHoursBilled}`,
);

if (failed > 0) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log("protractor-labor-hours smoke: all checks passed");
