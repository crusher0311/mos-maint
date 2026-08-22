import { buildRepairOrderQuery } from "../lib/integrations/shopware/request-query";

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`, detail ?? "");
  }
}

console.log("[1] single repair-order query");
{
  const query = buildRepairOrderQuery({
    associations: "services,services.labors,services.parts,customer,vehicle",
  });
  check(
    "encodes every association as a separate associations[] value",
    JSON.stringify(query.getAll("associations[]")) ===
      JSON.stringify(["services", "services.labors", "services.parts", "customer", "vehicle"]),
    query.toString()
  );
  check(
    "does not send the unsupported comma-delimited associations parameter",
    !query.has("associations"),
    query.toString()
  );
}

console.log("[2] paginated repair-order list query");
{
  const query = buildRepairOrderQuery({
    associations: "services, customer",
    updated_after: "2026-08-01T00:00:00.000Z",
    closed_after: "2026-08-02T00:00:00.000Z",
    shop_id: 5700,
    customer_id: 42,
    vehicle_id: 99,
  });
  query.set("per_page", "100");
  query.set("page", "3");

  check(
    "retains each requested association for a paginated list",
    JSON.stringify(query.getAll("associations[]")) === JSON.stringify(["services", "customer"]),
    query.toString()
  );
  check("keeps updated_after", query.get("updated_after") === "2026-08-01T00:00:00.000Z");
  check("keeps closed_after", query.get("closed_after") === "2026-08-02T00:00:00.000Z");
  check("keeps shop_id", query.get("shop_id") === "5700");
  check("keeps customer_id", query.get("customer_id") === "42");
  check("keeps vehicle_id", query.get("vehicle_id") === "99");
  check("keeps pagination", query.get("per_page") === "100" && query.get("page") === "3");
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}

console.log("\nAll Shop-Ware repair-order query checks passed");