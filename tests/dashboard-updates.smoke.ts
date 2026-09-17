import {
  bumpDashboardUpdate,
  getDashboardUpdateMarker,
  getDashboardUpdateToken,
} from "../lib/dashboard-updates";

let failed = 0;
function ok(name: string, condition: boolean) {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}`);
  }
}

async function run() {
  let call: any[] | null = null;
  const fakeDb: any = {
    collection: () => ({
      updateOne: async (...args: any[]) => {
        call = args;
        return { matchedCount: 1, modifiedCount: 1 };
      },
    }),
  };

  await bumpDashboardUpdate(fakeDb, "offline-test");
  const captured: any = call;
  ok("dashboard marker uses the durable singleton document", captured?.[0]?._id === "lastUpdate");
  ok(
    "dashboard marker update is an atomic monotonic pipeline",
    Array.isArray(captured?.[1]) &&
      captured?.[1][0]?.$set?.timestamp?.$let?.vars?.current?.$ifNull?.[0] === "$timestamp",
  );
  ok("dashboard marker requests upsert", captured?.[2]?.upsert === true);

  const scoped: any = {
    timestamp: 1000,
    shopTimestamps: { "432": 2000000000000, "900": 3000000000000 },
    shopVersions: { "432": 2, "900": 1 },
  };
  ok(
    "AutoFlow marker reads only the selected shop scope",
    getDashboardUpdateToken(scoped, 432) === "1000:0:2000000000000:2" &&
      getDashboardUpdateToken(scoped, 900) === "1000:0:3000000000000:1",
  );
  ok(
    "legacy lastUpdate remains the global timestamp",
    getDashboardUpdateMarker({ timestamp: 4, globalVersion: 2 }, 432) === 4,
  );
  ok(
    "global and scoped components remain independently comparable",
    getDashboardUpdateToken(
      { timestamp: 4, globalVersion: 2, shopTimestamps: { "432": 9000 }, shopVersions: { "432": 999999 } },
      432,
    ) === "4:2:9000:999999",
  );

  if (failed > 0) process.exitCode = 1;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});