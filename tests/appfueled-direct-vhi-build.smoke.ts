import assert from "node:assert/strict";
import { runWithAppFueledDirectVhiContext } from "../lib/external-api/appfueled-direct-vhi-context";
import { __deps, __triggerDeps, rebuildVhi, triggerPlanBuild } from "../lib/vhi-rebuild";

const plan: any = {
  buckets: {
    overdue: [{ key: "oil", serviceKey: "oil", title: "Oil service" }],
    dueSoon: [{ key: "coolant", serviceKey: "coolant", title: "Coolant" }],
    upcoming: [],
  },
  vehicle: { year: 2020, make: "Honda", model: "Accord", engine: "2.0L" },
  currentMiles: 48_000,
  mpdBlended: 32,
  customerName: "QA",
  latestRoNumber: "100",
  distanceUnit: "miles",
  soonMiles: 1_000,
  soonDays: 30,
  showInspectItems: true,
  mileageSource: "estimated_carfax",
  mileageEstimateDetails: { confidence: "high", dataPoints: 4 },
  dataQuality: {
    sufficient: true,
    carfaxStatus: "ok",
    anchorCount: 4,
    carfaxRecordCount: 4,
    shopHistoryCount: 0,
    reasons: [],
  },
};

async function main() {
  const original = { ...__deps };
  let reads = 0;
  let triggers = 0;
  let receivedMetadata: any;
  try {
    (__deps as any).getDb = async () => ({});
    (__deps as any).getCachedPlan = async () => {
      reads += 1;
      return { plan, createdAt: new Date("2025-01-01") };
    };
    (__deps as any).triggerPlanBuild = async (
      _shop: number,
      _vin: string,
      _mileage: number,
      _fast: boolean,
      _persist: boolean,
      metadata: unknown,
    ) => {
      triggers += 1;
      receivedMetadata = metadata;
      return { ok: true, plan, createdAt: new Date("2025-01-01") };
    };

    const legacy = await rebuildVhi(7, "1HGCM82633A004352", 48_000, {
      mileageSource: "estimated_carfax",
      mileageEstimateDetails: plan.mileageEstimateDetails,
    });
    assert.equal(reads, 1);
    assert.equal(triggers, 0);

    reads = 0;
    const direct = await runWithAppFueledDirectVhiContext({
      shopId: 7,
      vin: "1HGCM82633A004352",
      carfaxReport: { ok: true, vin: "1HGCM82633A004352", serviceRecords: [] },
      reportRevision: "accepted-r1",
      planCacheMissKnown: true,
    }, () => rebuildVhi(7, "1HGCM82633A004352", 48_000, {
      mileageSource: "estimated_carfax",
      mileageEstimateDetails: plan.mileageEstimateDetails,
    }));

    assert.equal(reads, 0, "authoritative prior miss bypasses duplicate cache read");
    assert.equal(triggers, 1);
    assert.deepEqual(receivedMetadata, {
      mileageSource: "estimated_carfax",
      mileageEstimateDetails: plan.mileageEstimateDetails,
    }, "mileage provenance is supplied to the initial plan build");
    assert.deepEqual(direct.score, legacy.score, "direct and legacy scoring agree");
    assert.deepEqual(direct.buckets, legacy.buckets, "direct and legacy buckets agree");
    assert.equal(direct.currentMiles, legacy.currentMiles);
  } finally {
    Object.assign(__deps, original);
  }

  const originalDirectPost = __triggerDeps.invokeDirectPost;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  let directPosts = 0;
  try {
    process.env.DATABASE_URL = "postgres://test-only";
    __triggerDeps.invokeDirectPost = async (url, headers) => {
      directPosts += 1;
      assert.match(url, /vin=1HGCM82633A004352/);
      assert.equal(headers["x-internal-shop-id"], "7");
      return Response.json({ ok: true, plan, createdAt: "2025-01-01T00:00:00.000Z" });
    };
    const result = await runWithAppFueledDirectVhiContext({
      shopId: 7,
      vin: "1HGCM82633A004352",
      carfaxReport: { ok: true, vin: "1HGCM82633A004352", serviceRecords: [] },
    }, () => triggerPlanBuild(7, "1HGCM82633A004352", 48_000, false, false, {
      mileageSource: "estimated_carfax",
      mileageEstimateDetails: plan.mileageEstimateDetails,
    }));
    assert.equal(result.ok, true);
    assert.equal(directPosts, 1, "trusted orchestration invokes plan POST in-process");
  } finally {
    __triggerDeps.invokeDirectPost = originalDirectPost;
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
  console.log("AppFueled direct VHI build orchestration smoke checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});