/**
 * Task #1064 — unit tests for the Shop-Ware Connect 404 → friendly-message
 * mapping and the authorized-tenant suggestion logic.
 *
 * Pure unit test over lib/integrations/shopware/connect-errors.ts (no
 * "server-only", no DB, no network).
 */
import {
  isShopWareNotFound,
  suggestTenantId,
  buildTenantConnectError,
} from "../lib/integrations/shopware/connect-errors";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}`, detail !== undefined ? detail : "");
  }
}

console.log("[1] isShopWareNotFound classification");
{
  const raw404 = new Error(
    'Shop-Ware API error 404 (https://api.shop-ware.com/api/v1/tenants/5852): {"error":"Not Found"}'
  );
  check("matches raw 404 error object", isShopWareNotFound(raw404));
  check("matches 404 message string", isShopWareNotFound(raw404.message));
  check("does not match 401", !isShopWareNotFound("Shop-Ware API error 401 (url): nope"));
  check("does not match 500", !isShopWareNotFound(new Error("Shop-Ware API error 500 (url): boom")));
  check("does not match unrelated error", !isShopWareNotFound(new Error("fetch failed")));
  check("handles undefined", !isShopWareNotFound(undefined));
}

console.log("[2] suggestTenantId");
{
  const auths = [{ tenant_id: 100 }, { tenant_id: 200 }, { tenant_id: 300 }];
  const shopMap = new Map<number, number[]>([
    [100, [1, 2]],
    [200, [6379, 7]],
    [300, [9]],
  ]);
  check(
    "suggests the single authorized tenant containing the shop",
    suggestTenantId(auths, 5852, 6379, shopMap) === 200
  );
  check(
    "no suggestion when no tenant contains the shop",
    suggestTenantId(auths, 5852, 4242, shopMap) === null
  );
  const ambiguous = new Map<number, number[]>([
    [100, [6379]],
    [200, [6379]],
  ]);
  check(
    "no suggestion when multiple tenants contain the shop (ambiguous)",
    suggestTenantId(auths, 5852, 6379, ambiguous) === null
  );
  check(
    "no suggestion when the entered tenant IS authorized (404 came from elsewhere)",
    suggestTenantId(auths, 200, 6379, shopMap) === null
  );
  check(
    "ignores shop-map entries for tenants not in the authorized list",
    suggestTenantId([{ tenant_id: 100 }], 5852, 6379, shopMap) === null
  );
  check(
    "handles empty authorizations",
    suggestTenantId([], 5852, 6379, shopMap) === null
  );
}

console.log("[3] buildTenantConnectError copy");
{
  const base = buildTenantConnectError({
    enteredTenantId: 5852,
    enteredShopId: 6379,
    usedShopIdFallback: false,
    suggestedTenantId: null,
  });
  check("mentions the tenant ID", base.includes("5852"));
  check(
    "explains not-found vs not-authorized ambiguity",
    /doesn't exist or hasn't authorized/.test(base)
  );
  check(
    "gives the next step (authorize in Shop-Ware, then retry)",
    /authorize the partner connection in Shop-Ware, then retry/.test(base)
  );
  check("no raw JSON blob", !base.includes("{") && !base.includes("Not Found"));
  check("no raw URL", !base.includes("http"));
  check(
    "no fallback note when a tenant ID was entered",
    !base.includes("left blank")
  );

  const fallback = buildTenantConnectError({
    enteredTenantId: 6379,
    enteredShopId: 6379,
    usedShopIdFallback: true,
    suggestedTenantId: null,
  });
  check(
    "explains the blank-Tenant-ID → Shop-ID fallback",
    fallback.includes("left blank") && fallback.includes("Shop ID (6379)")
  );

  const suggested = buildTenantConnectError({
    enteredTenantId: 5852,
    enteredShopId: 6379,
    usedShopIdFallback: false,
    suggestedTenantId: 200,
  });
  check("suggests the matching tenant ID", /try Tenant ID 200/.test(suggested));
  check(
    "suggestion replaces the generic double-check step",
    !suggested.includes("Double-check the Tenant ID")
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll shopware-connect-errors checks passed");
