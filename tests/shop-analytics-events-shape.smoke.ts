/**
 * Task #998 — shop analytics recommendation-events shape smoke test.
 *
 * The /api/shop/analytics route consumes FLATTENED rows from the facade
 * (`{ eventType, recommendationType, count, ... }` and
 * `{ date, eventType, count, revenue }`), not raw Mongo `_id`-grouped
 * aggregation docs. This test drives the facade's Mongo arm with a fake
 * db and mixed added/sold data (with a date filter) and re-runs the
 * route's summary/daily reduction logic against the returned shape, so
 * a regression back to `_id.*` access is caught without a live DB.
 *
 * Run: npx tsx tests/shop-analytics-events-shape.smoke.ts
 */
import assert from "node:assert";

process.env.PLAN_CACHE_PG_CANONICAL = ""; // Mongo arm

function fakeDb(aggregateRows: (pipeline: any[]) => any[]) {
  return {
    collection(name: string) {
      assert.equal(name, "recommendation_events");
      return {
        aggregate(pipeline: any[]) {
          return { toArray: async () => aggregateRows(pipeline) };
        },
      };
    },
  } as any;
}

async function main() {
  const { summarizeRecommendationEvents, dailyRecommendationEvents } = await import(
    "../lib/data/repositories/plan-cache-store"
  );

  const startDate = new Date("2026-07-01");
  const endDate = new Date("2026-07-31");

  /* ---- summary arm ---- */
  let capturedMatch: any = null;
  const summaryDb = fakeDb((pipeline) => {
    capturedMatch = pipeline[0].$match;
    return [
      {
        _id: { eventType: "recommendation_added", recommendationType: "oil_change" },
        count: 3,
        totalRevenue: 0,
        laborRevenue: 0,
        partsRevenue: 0,
      },
      {
        _id: { eventType: "recommendation_sold", recommendationType: "oil_change" },
        count: 2,
        totalRevenue: 150,
        laborRevenue: 90,
        partsRevenue: 60,
      },
    ];
  });

  const events = await summarizeRecommendationEvents(42, startDate, endDate, summaryDb);
  // date filter must reach the Mongo match stage
  assert.equal(capturedMatch.shopId, 42);
  assert.equal(capturedMatch.createdAt.$gte, startDate);
  assert.equal(capturedMatch.createdAt.$lte, endDate);
  // rows must be FLAT (no _id)
  for (const e of events) assert.equal((e as any)._id, undefined, "rows must be flattened");

  // Replay the route's summary reduction
  let jobsAdded = 0, jobsSold = 0, totalRevenue = 0;
  for (const event of events) {
    if (event.eventType === "recommendation_added") jobsAdded += event.count;
    else if (event.eventType === "recommendation_sold") {
      jobsSold += event.count;
      totalRevenue += event.totalRevenue;
    }
  }
  assert.equal(jobsAdded, 3);
  assert.equal(jobsSold, 2);
  assert.equal(totalRevenue, 150);

  /* ---- daily arm ---- */
  const dailyDb = fakeDb(() => [
    { _id: { date: "2026-07-30", eventType: "recommendation_added" }, count: 4, revenue: 0 },
    { _id: { date: "2026-07-30", eventType: "recommendation_sold" }, count: 1, revenue: 75 },
    { _id: { date: "2026-07-29", eventType: "recommendation_sold" }, count: 2, revenue: 120 },
  ]);
  const dailyData = await dailyRecommendationEvents(42, startDate, endDate, 60, dailyDb);
  for (const d of dailyData) assert.equal((d as any)._id, undefined, "daily rows must be flattened");

  // Replay the route's daily reduction (both branches on the flat shape)
  const dailyMap: Record<string, { date: string; added: number; sold: number; revenue: number }> = {};
  for (const d of dailyData) {
    const date = d.date;
    if (!dailyMap[date]) dailyMap[date] = { date, added: 0, sold: 0, revenue: 0 };
    if (d.eventType === "recommendation_added") dailyMap[date].added += d.count;
    else if (d.eventType === "recommendation_sold") {
      dailyMap[date].sold += d.count;
      dailyMap[date].revenue += d.revenue;
    }
  }
  assert.deepEqual(dailyMap["2026-07-30"], { date: "2026-07-30", added: 4, sold: 1, revenue: 75 });
  assert.deepEqual(dailyMap["2026-07-29"], { date: "2026-07-29", added: 0, sold: 2, revenue: 120 });

  console.log("shop-analytics events shape smoke: ALL PASS");
}

main().catch((err) => {
  console.error("SMOKE FAIL:", err);
  process.exit(1);
});
