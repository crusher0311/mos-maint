import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import {
  FEATURE_KEYS,
  featuresForPlan,
  buildAllFeaturesEnabled,
} from "../lib/plan-feature-tiers";
import { FEATURE_METADATA } from "../lib/featureResolver";
import { filterNavItemsByFeatures } from "../lib/sidebar-nav";
import {
  AUTO_DVI_REQUIRED_FEATURES,
  canAccessShopFeature,
  canPlatformAdminBypassShopFeatures,
} from "../lib/shop-feature-access";
import { resolveFloatingDetectDog } from "../lib/floating-detect-dog";

let passed = 0;
function ok(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}
function source(file: string) {
  return fs.readFileSync(path.join(process.cwd(), file), "utf8");
}
function entitlements(enabled: Record<string, boolean>, billingActive = true) {
  return {
    features: enabled,
    effectiveFeatures: enabled,
    billing: { plan: "trial" as const, status: "active" as const },
    canUseFeature: (key: string) => billingActive && enabled[key] === true,
    isFeatureEnabled: (key: string) => enabled[key] === true,
    isBillingActive: () => billingActive,
  } as any;
}

ok("Sales Coach is canonical, admin-visible metadata, and dark by default", () => {
  assert.ok(FEATURE_KEYS.includes("sales_coach"));
  assert.strictEqual(FEATURE_METADATA.sales_coach.name, "Sales Coach");
  assert.strictEqual(featuresForPlan("elite").sales_coach, false);
  assert.strictEqual(buildAllFeaturesEnabled().sales_coach, true);
});

ok("sidebar hides Sales Coach unless its dedicated feature is enabled", () => {
  const nav = [{ name: "Sales Coach", featureId: "sales_coach" }];
  assert.deepStrictEqual(filterNavItemsByFeatures(nav, []), []);
  assert.deepStrictEqual(filterNavItemsByFeatures(nav, ["sales_coach"]), nav);
  assert.match(source("components/ui/Sidebar.tsx"), /name:\s*"Sales Coach"[\s\S]*?featureId:\s*"sales_coach"/);
});

ok("shop access honors entitlement and billing state", () => {
  assert.strictEqual(canAccessShopFeature({}, entitlements({ sales_coach: false }), "sales_coach"), false);
  assert.strictEqual(canAccessShopFeature({}, entitlements({ sales_coach: true }), "sales_coach"), true);
  assert.strictEqual(canAccessShopFeature({}, entitlements({ sales_coach: true }, false), "sales_coach"), false);
  assert.strictEqual(canAccessShopFeature({}, entitlements({ maintenance: false }), "maintenance"), false);
  assert.strictEqual(canAccessShopFeature({}, entitlements({ maintenance: true }), "maintenance"), true);
});

ok("platform-admin bypass never leaks into an impersonated shop session", () => {
  const disabled = entitlements({ sales_coach: false, maintenance: false });
  assert.strictEqual(canAccessShopFeature({ isPlatformAdmin: true }, disabled, "sales_coach"), true);
  assert.strictEqual(
    canAccessShopFeature({ isPlatformAdmin: true, isImpersonation: true }, disabled, "sales_coach"),
    false,
  );
  assert.strictEqual(
    canAccessShopFeature({ isPlatformAdmin: true, isImpersonation: true }, disabled, "maintenance"),
    false,
  );
});

ok("Sales Coach page and API both require sales_coach", () => {
  const layout = source("app/dashboard/sales-coach/layout.tsx");
  const api = source("app/api/sales-script/route.ts");
  assert.match(layout, /canAccessShopFeature\(session,\s*entitlements,\s*"sales_coach"\)/);
  assert.match(api, /canAccessShopFeature\(session,\s*entitlements,\s*"sales_coach"\)/);
  assert.match(api, /status:\s*403/);
});

ok("all dashboard VHI pages require Maintenance", () => {
  for (const file of [
    "app/dashboard/vehicles/[vin]/page.tsx",
    "app/dashboard/vehicles/[vin]/plan/page.tsx",
    "app/dashboard/vehicles/[vin]/inspect/page.tsx",
    "app/dashboard/vehicles/[vin]/recommend/page.tsx",
    "app/dashboard/analyzer/[vin]/page.tsx",
  ]) {
    assert.match(source(file), /canAccessShopFeature\(session,[\s\S]{0,80}"maintenance"\)/, file);
  }
});

ok("dashboard VHI read/build APIs deny missing Maintenance before work", () => {
  for (const file of [
    "app/api/vehicles/[vin]/vhi/route.ts",
    "app/api/vehicles/[vin]/recalls/route.ts",
    "app/api/vehicles/[vin]/specs/route.ts",
    "app/api/plan-build/route.ts",
    "app/api/plan-prefetch/route.ts",
    "app/api/plan-prefetch/batch/route.ts",
    "app/api/vehicle-analyzer/route.ts",
  ]) {
    const text = source(file);
    assert.match(text, /canAccessShopFeature\(session,[\s\S]{0,80}"maintenance"\)/, file);
    assert.match(text, /Feature not enabled[\s\S]{0,80}status:\s*403/, file);
  }
});

ok("launcher default is off for sticker/keytag-only sets and on otherwise", () => {
  assert.strictEqual(resolveFloatingDetectDog({ effectiveFeatures: { oil_sticker: true } }).enabled, false);
  assert.strictEqual(resolveFloatingDetectDog({ effectiveFeatures: { keytags: true } }).enabled, false);
  assert.strictEqual(
    resolveFloatingDetectDog({ effectiveFeatures: { oil_sticker: true, keytags: true } }).enabled,
    false,
  );
  assert.strictEqual(
    resolveFloatingDetectDog({ effectiveFeatures: { oil_sticker: true, maintenance: true } }).enabled,
    true,
  );
  assert.strictEqual(resolveFloatingDetectDog({ effectiveFeatures: {} }).enabled, true);
});

ok("explicit owner and user launcher preferences retain precedence", () => {
  assert.strictEqual(
    resolveFloatingDetectDog({ effectiveFeatures: { oil_sticker: true }, ownerPreference: true }).enabled,
    true,
  );
  assert.strictEqual(
    resolveFloatingDetectDog({ effectiveFeatures: { maintenance: true }, ownerPreference: false }).enabled,
    false,
  );
  assert.strictEqual(
    resolveFloatingDetectDog({
      effectiveFeatures: { maintenance: true },
      ownerPreference: true,
      userPreference: false,
    }).enabled,
    false,
  );
  assert.strictEqual(
    resolveFloatingDetectDog({
      effectiveFeatures: { oil_sticker: true },
      ownerPreference: false,
      userPreference: true,
    }).enabled,
    false,
  );
});

ok("platform-admin shop management exposes the Sales Coach override", () => {
  const admin = source("app/platform-admin/shops/page.tsx");
  const seed = source("app/api/platform-admin/features/seed/route.ts");
  assert.match(admin, /sales_coach\?: boolean/);
  assert.ok((admin.match(/key:\s*"sales_coach"/g) ?? []).length >= 2);
  assert.match(seed, /slug:\s*"sales_coach"[\s\S]*?includedInTiers:\s*\[\]/);
  assert.match(seed, /insertMissingPlatformFeatures\(featuresWithTimestamps\)/);
  assert.match(seed, /\.insert\(platformFeatures\)[\s\S]*?onConflictDoNothing\(\{\s*target:\s*platformFeatures\.slug\s*\}\)/);
});

ok("Auto DVI dashboard APIs require Maintenance and do not leak admin impersonation", () => {
  for (const file of [
    "app/api/auto-dvi/generate/route.ts",
    "app/api/auto-dvi/results/route.ts",
    "app/api/auto-dvi/push/route.ts",
    "app/api/auto-dvi/voice/route.ts",
    "app/api/auto-dvi/photo-assign/route.ts",
    "app/api/auto-dvi/media/route.ts",
    "app/api/auto-dvi/media/[mediaId]/route.ts",
  ]) {
    const text = source(file);
    assert.match(text, /\["maintenance",\s*"auto_dvi"\]/, file);
    assert.match(text, /isPlatformAdmin:[\s\S]{0,80}!session\.isImpersonation/, file);
  }
});

ok("Auto DVI extension and settings APIs also require Maintenance", () => {
  assert.deepStrictEqual(AUTO_DVI_REQUIRED_FEATURES, ["maintenance", "auto_dvi"]);
  assert.strictEqual(canPlatformAdminBypassShopFeatures({ isPlatformAdmin: true }), true);
  assert.strictEqual(
    canPlatformAdminBypassShopFeatures({ isPlatformAdmin: true, isImpersonation: true }),
    false,
  );
  for (const file of [
    "app/api/extension/auto-dvi/generate/route.ts",
    "app/api/extension/auto-dvi/media/route.ts",
    "app/api/extension/auto-dvi/push/route.ts",
    "app/api/extension/auto-dvi/results/route.ts",
    "app/api/extension/auto-dvi/voice/route.ts",
  ]) {
    assert.match(source(file), /requiredFeatures:\s*AUTO_DVI_REQUIRED_FEATURES/, file);
  }
  const settings = source("app/api/settings/auto-dvi-items/route.ts");
  assert.ok((settings.match(/checkShopFeatureGate\(shopId,\s*AUTO_DVI_REQUIRED_FEATURES/g) ?? []).length >= 2);
  assert.ok((settings.match(/canPlatformAdminBypassShopFeatures\(session\)/g) ?? []).length >= 2);
});

ok("signed VHI reports stop at issuance, viewing, and media when Maintenance is disabled", () => {
  const report = source("app/api/report/[vin]/route.ts");
  const media = source("app/api/report/[vin]/media/[mediaId]/route.ts");
  assert.match(report, /entitlements\.canUseFeature\("maintenance"\)/);
  assert.match(report, /canAccessShopFeature\(session,\s*entitlements,\s*"maintenance"\)/);
  assert.ok((report.match(/Feature not enabled/g) ?? []).length >= 2);
  assert.match(media, /entitlements\.canUseFeature\("maintenance"\)/);
  assert.match(media, /Feature not enabled[\s\S]{0,80}status:\s*403/);
});

ok("external VHI and maintenance APIs enforce the target shop's Maintenance product", () => {
  for (const file of [
    "app/api/external/vehicles/[vin]/route.ts",
    "lib/external-api/partner-vhi-service.ts",
    "app/api/external/vhi/analyze/route.ts",
    "app/api/external/vehicles/[vin]/maintenance/route.ts",
    "app/api/external/recommendations/[vin]/route.ts",
  ]) {
    const text = source(file);
    assert.match(text, /getFeatureEntitlements\(Number\([^)]+\)\)/, file);
    assert.match(text, /entitlements\.canUseFeature\("maintenance"\)/, file);
    assert.match(text, /Feature not enabled[\s\S]{0,100}status:\s*403/, file);
  }
  const externalVehicle = source("app/api/external/vehicles/[vin]/route.ts");
  assert.match(externalVehicle, /shopId:\s*\{\s*\$in:\s*\[Number\(shopId\),\s*String\(shopId\)\]\s*\}/);
  const extensionSpecs = source("app/api/extension/specs/route.ts");
  assert.match(extensionSpecs, /checkShopFeatureGate\(shopId,\s*\["maintenance"\]/);
});

ok("recommendation surfaces require Maintenance and Estimate Assist cannot leak cached VHI", () => {
  for (const file of [
    "app/dashboard/recommended/page.tsx",
    "app/api/recommended/analyze/route.ts",
    "app/api/recommended/analyze-stream/route.ts",
    "app/api/recommended/cache/route.ts",
  ]) {
    const text = source(file);
    assert.match(text, /canAccessShopFeature\([\s\S]{0,100}"maintenance"\)/, file);
  }
  const audit = source("app/api/estimate-assist/audit/route.ts");
  assert.match(audit, /const canUseMaintenance = canAccessShopFeature\(/);
  assert.match(audit, /if \(vehicleVin && canUseMaintenance\)/);
  const legacyAnalyze = source("app/api/analyze/route.ts");
  assert.match(
    legacyAnalyze,
    /canAccessShopFeature\(session,\s*entitlements,\s*"maintenance"\)/,
  );
  assert.ok(
    legacyAnalyze.indexOf('canAccessShopFeature(session, entitlements, "maintenance")') <
      legacyAnalyze.indexOf("const blocked = await enforceAiBudget"),
  );
  const missedOpportunities = source("app/api/reports/missed-opportunities/route.ts");
  assert.match(
    missedOpportunities,
    /canAccessShopFeature\(session,\s*entitlements,\s*"maintenance"\)/,
  );
  assert.ok(
    missedOpportunities.indexOf('canAccessShopFeature(session, entitlements, "maintenance")') <
      missedOpportunities.indexOf("const cached = await getCachedMissedOppReport"),
  );
  const autoVitals = source("app/api/autovitals/extension/vehicle-data/route.ts");
  assert.match(autoVitals, /entitlements\.canUseFeature\("maintenance"\)/);
  assert.ok(
    autoVitals.indexOf('entitlements.canUseFeature("maintenance")') <
      autoVitals.indexOf('db.collection("vehicles")'),
  );
});

ok("Maintenance analytics, lifecycle writes, and schedule settings require Maintenance", () => {
  for (const file of [
    "app/api/shop/analytics/route.ts",
    "app/api/deferred/remedy/route.ts",
    "app/api/vehicles/[vin]/oil-duty/route.ts",
    "app/dashboard/settings/maintenance/page.tsx",
    "app/dashboard/settings/intervals/page.tsx",
    "app/api/dashboard/settings/interval-import/route.ts",
    "app/api/carfax/debug/[vin]/route.ts",
    "app/api/enrichment/process/route.ts",
    "app/api/protection-plan/enrollment/route.ts",
    "app/api/vehicle/driving-stats/route.ts",
    "app/dashboard/protection-plans/page.tsx",
    "app/api/settings/carfax/route.ts",
  ]) {
    assert.match(
      source(file),
      /canAccessShopFeature\([\s\S]{0,120}"maintenance"\)/,
      file,
    );
  }
  const oilDuty = source("app/api/vehicles/[vin]/oil-duty/route.ts");
  assert.ok((oilDuty.match(/canAccessShopFeature\(/g) ?? []).length >= 2);
  const settings = source("app/dashboard/settings/maintenance/page.tsx");
  assert.ok((settings.match(/canAccessShopFeature\(/g) ?? []).length >= 2);
  const intervals = source("app/dashboard/settings/intervals/page.tsx");
  assert.ok((intervals.match(/requireMaintenanceSession\(\)/g) ?? []).length >= 3);
  const enrichment = source("app/api/enrichment/process/route.ts");
  assert.ok((enrichment.match(/canAccessShopFeature\(/g) ?? []).length >= 2);
  const enrollment = source("app/api/protection-plan/enrollment/route.ts");
  assert.ok((enrollment.match(/canUseMaintenance\(sess\)/g) ?? []).length >= 3);
  const dashboardData = source("app/api/dashboard/data/route.ts");
  const dashboardDataV2 = source("app/api/dashboard/data-v2/route.ts");
  assert.match(dashboardData, /if \(maintenanceEnabled\) await batchEstimateMileage/);
  assert.ok((dashboardDataV2.match(/if \(maintenanceEnabled\) await batchEstimateMileage/g) ?? []).length >= 2);
  const carfaxSettings = source("app/api/settings/carfax/route.ts");
  assert.ok((carfaxSettings.match(/requireMaintenanceSession\(\)/g) ?? []).length >= 3);
});

console.log(`\nAll ${passed} shop product entitlement smoke tests passed.`);