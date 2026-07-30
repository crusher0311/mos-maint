/**
 * Smoke test for the Estimate Assist sidebar entry (task: surface
 * Estimate Assist in the dashboard).
 *
 * Two regression targets:
 *  1. The pure gating filter (`lib/sidebar-nav.ts`) must include a nav
 *     item gated on `estimate_assist` only when the shop's enabled
 *     feature list contains it — same show/hide contract as the other
 *     entitlement-gated items (auto_booking, oil_sticker, part_xref).
 *  2. The Sidebar component must actually declare the Estimate Assist
 *     entry (href /dashboard/estimate-audit, featureId estimate_assist)
 *     and route its nav list through the shared filter — so a refactor
 *     can't silently drop the entry or bypass the gate.
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { filterNavItemsByFeatures } from "../lib/sidebar-nav";

function main() {
  const nav = [
    { name: "Dashboard", href: "/dashboard" },
    {
      name: "Estimate Assist",
      href: "/dashboard/estimate-audit",
      featureId: "estimate_assist",
    },
    {
      name: "Settings",
      href: "/dashboard/settings",
      children: [
        { name: "Keytags", href: "/dashboard/settings/keytags", featureId: "keytags" },
        { name: "Users", href: "/dashboard/settings/users" },
      ],
    },
  ];

  // Enabled -> entry present.
  const withFeature = filterNavItemsByFeatures(nav, ["maintenance", "estimate_assist"]);
  assert.ok(
    withFeature.some(i => i.name === "Estimate Assist"),
    "Estimate Assist nav item should be visible when estimate_assist is enabled",
  );

  // Disabled -> entry absent; ungated items untouched.
  const withoutFeature = filterNavItemsByFeatures(nav, ["maintenance"]);
  assert.ok(
    !withoutFeature.some(i => i.name === "Estimate Assist"),
    "Estimate Assist nav item should be hidden when estimate_assist is not enabled",
  );
  assert.ok(withoutFeature.some(i => i.name === "Dashboard"), "ungated items must remain");

  // Child gating still works (keytags gated, Users not).
  const settings = withoutFeature.find(i => i.name === "Settings");
  assert.ok(settings && settings.children, "Settings group must remain");
  assert.ok(!settings!.children!.some((c: any) => c.name === "Keytags"), "gated child hidden");
  assert.ok(settings!.children!.some((c: any) => c.name === "Users"), "ungated child kept");

  // Group whose children are ALL gated away is dropped.
  const allGated = filterNavItemsByFeatures(
    [{ name: "G", href: "#", children: [{ name: "x", href: "#", featureId: "keytags" }] }],
    [],
  );
  assert.strictEqual(allGated.length, 0, "empty gated group should be dropped");

  // Source-level guard: Sidebar declares the entry and uses the shared filter.
  const src = readFileSync(join(__dirname, "..", "components", "ui", "Sidebar.tsx"), "utf8");
  assert.ok(
    src.includes('href: "/dashboard/estimate-audit"'),
    "Sidebar.tsx must declare the Estimate Assist nav entry",
  );
  assert.ok(
    /featureId:\s*"estimate_assist"/.test(src),
    "Estimate Assist nav entry must be gated on the estimate_assist feature",
  );
  assert.ok(
    src.includes("filterNavItemsByFeatures(navItems, enabledFeatures)"),
    "Sidebar.tsx must gate its nav items through filterNavItemsByFeatures",
  );

  console.log("sidebar-estimate-assist-nav smoke test passed");
}

main();
