import assert from "node:assert/strict";
import {
  getAppFueledDirectVhiContext,
  getTrustedAppFueledReport,
  isAppFueledDirectVhiEnabled,
  runWithAppFueledDirectVhiContext,
} from "../lib/external-api/appfueled-direct-vhi-context";
import {
  __partnerBuildTest,
  runCoalescedAppFueledBuild,
} from "../lib/external-api/partner-vhi-build";

async function main() {
  const previous = process.env.APPFUELED_DIRECT_VHI_ENABLED;
  delete process.env.APPFUELED_DIRECT_VHI_ENABLED;
  assert.equal(isAppFueledDirectVhiEnabled(), false, "switch defaults off");
  process.env.APPFUELED_DIRECT_VHI_ENABLED = "true";
  assert.equal(isAppFueledDirectVhiEnabled(), true);

  const reportA = { ok: true as const, reportDate: "2025-01-01", serviceRecords: [] };
  const reportB = { ok: true as const, reportDate: "2025-01-02", serviceRecords: [] };
  await Promise.all([
    runWithAppFueledDirectVhiContext(
      { shopId: 1, vin: "1HGCM82633A004352", carfaxReport: reportA },
      async () => {
        await Promise.resolve();
        assert.equal(getAppFueledDirectVhiContext()?.carfaxReport, reportA);
        assert.equal(getTrustedAppFueledReport(1, "1HGCM82633A004352"), reportA);
        assert.equal(getTrustedAppFueledReport(2, "1HGCM82633A004352"), undefined);
      },
    ),
    runWithAppFueledDirectVhiContext(
      { shopId: 2, vin: "1M8GDM9AXKP042788", carfaxReport: reportB },
      async () => {
        await Promise.resolve();
        assert.equal(getAppFueledDirectVhiContext()?.carfaxReport, reportB);
      },
    ),
  ]);
  assert.equal(getAppFueledDirectVhiContext(), undefined, "context does not leak");
  await runWithAppFueledDirectVhiContext(
    {
      shopId: 1,
      vin: "1HGCM82633A004352",
      carfaxReport: { ok: true, vin: "1M8GDM9AXKP042788", serviceRecords: [] },
    },
    async () => assert.equal(
      getTrustedAppFueledReport(1, "1HGCM82633A004352"),
      undefined,
      "mismatched report VIN is rejected",
    ),
  );

  __partnerBuildTest.clear();
  let builds = 0;
  const values = await runWithAppFueledDirectVhiContext(
    { shopId: 1, vin: "1HGCM82633A004352", carfaxReport: reportA, reportRevision: "r1" },
    () => Promise.all([
      runCoalescedAppFueledBuild(1, "1HGCM82633A004352", 42, async () => {
        builds += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return "built";
      }),
      runCoalescedAppFueledBuild(1, "1HGCM82633A004352", 42, async () => {
        builds += 1;
        return "duplicate";
      }),
    ]),
  );
  assert.deepEqual(values, ["built", "built"]);
  assert.equal(builds, 1, "identical builds coalesce");
  assert.equal(__partnerBuildTest.inFlightSize(), 0, "successful result is not cached");

  const never = new Promise(() => {});
  __partnerBuildTest.seed("expired-hung", 0, never);
  __partnerBuildTest.sweepExpired(__partnerBuildTest.maxAgeMs + 1);
  assert.equal(__partnerBuildTest.inFlightSize(), 0, "expired hung keys are swept");

  if (previous === undefined) delete process.env.APPFUELED_DIRECT_VHI_ENABLED;
  else process.env.APPFUELED_DIRECT_VHI_ENABLED = previous;
  console.log("AppFueled direct VHI context smoke checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});