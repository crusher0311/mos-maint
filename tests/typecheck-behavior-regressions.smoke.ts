import {
  isTrialBillingStatus,
  type BillingStatus,
} from "../lib/featureResolver";
import { classifyMaintenanceScheduleFailure } from "../lib/external-api/maintenance-schedule";

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