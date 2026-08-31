import {
  isTrialBillingStatus,
  type BillingStatus,
} from "../lib/featureResolver";
import {
  isBillingStatusActive,
  resolveEffectiveBillingStatus,
} from "../lib/billing-helpers";
import { SUPPORT_EMAIL } from "../lib/support-contact";
import { classifyMaintenanceScheduleFailure } from "../lib/external-api/maintenance-schedule";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

let failed = 0;

function ok(name: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}`);
  }
}

console.log("Type-check repair behavior regressions");

const stripeTrialStatus: BillingStatus = "trialing";
ok("Stripe trialing status remains an active trial", isTrialBillingStatus(stripeTrialStatus));
ok("legacy trial status remains an active trial", isTrialBillingStatus("trial"));
ok("active paid status is not presented as a trial", !isTrialBillingStatus("active"));

ok(
  "invoice billing overrides a stale canceled Stripe-style status",
  resolveEffectiveBillingStatus({ paymentType: "invoice", status: "canceled" }) === "active",
);
ok(
  "invoice billing without a stored status defaults active",
  resolveEffectiveBillingStatus({ paymentType: "invoice" }) === "active",
);
ok(
  "a genuine Stripe cancellation remains canceled",
  resolveEffectiveBillingStatus({ paymentType: "stripe", status: "canceled" }) === "canceled",
);
for (const status of [
  "trial",
  "trialing",
  "active",
  "past_due",
  "suspended",
  "paused",
  "unpaid",
  "incomplete",
  "incomplete_expired",
  "enterprise",
  "demo",
] as const) {
  ok(
    `${status} billing status is preserved`,
    resolveEffectiveBillingStatus({ paymentType: "invoice", status }) === status,
  );
}
ok("past-due billing retains feature access during grace", isBillingStatusActive("past_due"));
ok("suspended billing does not retain feature access", !isBillingStatusActive("suspended"));
ok("canceled billing does not retain feature access", !isBillingStatusActive("canceled"));
for (const status of ["paused", "unpaid", "incomplete", "incomplete_expired"] as const) {
  ok(`${status} billing does not retain feature access`, !isBillingStatusActive(status));
}

const customerFacingSupportSources = [
  "lib/email.ts",
  "components/ui/BillingStatusBanner.tsx",
  "components/ui/TrialUpgradePrompt.tsx",
  "components/JobLookup.tsx",
  "components/EstimateAssistPanel.tsx",
  "app/dashboard/onboarding/page.tsx",
  "app/dashboard/settings/auto-booking/page.tsx",
  "app/LandingPage.tsx",
  "app/LandingPagePromo.tsx",
  "app/privacy/page.tsx",
];
const supportSources = customerFacingSupportSources.map((path) => ({
  path,
  source: readFileSync(resolve(process.cwd(), path), "utf8"),
}));
for (const legacyAddress of ["support@mosmaintenance.com", "support@mos.tools"]) {
  ok(
    `customer-facing sources contain no ${legacyAddress}`,
    supportSources.every(({ source }) => !source.includes(legacyAddress)),
  );
}
ok("canonical support contact is MyOilSticker", SUPPORT_EMAIL === "support@myoilsticker.com");
ok(
  "customer-facing sources use the canonical support contact",
  supportSources.every(({ source }) =>
    source.includes("support@myoilsticker.com") ||
    source.includes("SUPPORT_EMAIL") ||
    source.includes("SUPPORT_MAILTO"),
  ),
);
ok(
  "third-party Protractor support destination remains unchanged",
  readFileSync(resolve(process.cwd(), "lib/email.ts"), "utf8").includes(
    'to: "support@protractor.com"',
  ),
);

const featureResolverSource = readFileSync(
  resolve(process.cwd(), "lib/featureResolver.ts"),
  "utf8",
);
const billingSettingsSource = readFileSync(
  resolve(process.cwd(), "app/api/settings/billing/route.ts"),
  "utf8",
);
const shopFeaturesSource = readFileSync(
  resolve(process.cwd(), "app/api/shop/features/route.ts"),
  "utf8",
);
const ghostStatusSource = readFileSync(
  resolve(process.cwd(), "app/api/ghost-mode/status/route.ts"),
  "utf8",
);
ok(
  "feature entitlements use shared effective billing resolution",
  featureResolverSource.includes("resolveEffectiveBillingStatus(shop.billing"),
);
ok(
  "billing settings use shared effective billing resolution",
  billingSettingsSource.includes("resolveEffectiveBillingStatus(billing"),
);
ok(
  "features endpoint resolves the currently viewed session shop",
  shopFeaturesSource.includes("Number(session.shopId)") &&
    shopFeaturesSource.includes("getFeatureEntitlements(shopId)"),
);
ok(
  "billing settings resolves the currently viewed session shop",
  billingSettingsSource.includes("Number(sess.shopId)") &&
    billingSettingsSource.includes("findShopByShopId<BillingShopDoc>(shopId)"),
);
ok(
  "Ghost Mode resolves shop identity from the active impersonation session",
  ghostStatusSource.includes("const currentSession = await getSession()") &&
    ghostStatusSource.includes("currentSession?.isImpersonation") &&
    ghostStatusSource.includes("findShopByShopId(currentSession.shopId)") &&
    !ghostStatusSource.includes("findShopByShopId(adminToken"),
);

const noData = classifyMaintenanceScheduleFailure({
  ok: false,
  error: "No maintenance data found for this VIN",
});
ok("missing DataOne schedule maps to 404", noData?.status === 404);

const upstreamFailure = classifyMaintenanceScheduleFailure({
  ok: false,
  error: "API error: 503",
});
ok("DataOne upstream failure maps to 502", upstreamFailure?.status === 502);
ok(
  "successful DataOne schedule has no failure classification",
  classifyMaintenanceScheduleFailure({ ok: true }) === null,
);

if (failed > 0) {
  console.error(`\n${failed} behavior regression check(s) failed`);
  process.exit(1);
}

console.log("\nAll type-check behavior regression checks passed");