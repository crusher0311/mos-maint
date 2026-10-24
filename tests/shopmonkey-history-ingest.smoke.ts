/**
 * Shopmonkey service-job history ingestion smoke test.
 *
 * Locks in the pieces that turn cached/fetched Shopmonkey orders into
 * job_index history rows:
 *  1. normalized-adapter extraction: serviceItems synthetic job, embedded
 *     services[], and the has-money fallback (order totals, no lines).
 *  2. NIS buildShopmonkeyLinesByJob: cents→dollars line map keyed by raw job
 *     id AND title.
 *  3. writeToJobIndex terminal gate: estimates/in-progress orders never write
 *     history; invoiced/dated orders do (with performedAt/mileage/lines).
 *
 * Run: NODE_OPTIONS='--require ./scripts/_stubs/server-only-stub.cjs' tsx tests/shopmonkey-history-ingest.smoke.ts
 */

export {};

let failures = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.error(`  ✗ ${name}`, extra ?? "");
  }
}

async function main() {
  // Import the core registry FIRST — importing the shopmonkey adapter module
  // directly trips a circular-init between it and core/normalized-adapter.
  const { NormalizedIngestionService } = await import(
    "@/lib/integrations/core/normalized-ingestion"
  );
  const { ShopmonkeyAdapter } = await import(
    "@/lib/integrations/shopmonkey/normalized-adapter"
  );

  const adapter: any = new ShopmonkeyAdapter();

  console.log("[shopmonkey-history] adapter extraction");
  const orderWithItems: any = {
    id: "ord_1",
    number: 1001,
    status: "Invoice",
    invoicedDate: "2026-07-01T00:00:00Z",
    generatedName: "Oil Change, Brake Pads",
    laborCents: 10000,
    partsCents: 5000,
    totalCostCents: 15000,
    mileageIn: 42000,
    serviceItems: [
      { id: "li_l", type: "labor", name: "Labor", hours: 1.5, rateCents: 10000, totalCents: 15000 },
      { id: "li_p", type: "part", name: "Oil Filter", quantity: 1, priceCents: 5000, totalCents: 5000, partNumber: "PH7317" },
    ],
  };
  const jobs1 = adapter.extractServiceJobsFromWorkOrder(orderWithItems);
  check("serviceItems → one synthetic job", jobs1.length === 1);
  check("synthetic job title from generatedName", jobs1[0]?.title === "Oil Change, Brake Pads");
  check("synthetic job total cents→dollars", jobs1[0]?.total === 150);

  const raw1 = adapter.extractRawServiceJobsFromWorkOrder(orderWithItems);
  check("raw synthetic job id = order id", String(raw1[0]?.id) === "ord_1");

  const moneyOnly: any = {
    id: "ord_2",
    status: "Invoice",
    generatedName: "Winterize",
    totalCostCents: 30000,
    laborCents: 30000,
  };
  const jobs2 = adapter.extractServiceJobsFromWorkOrder(moneyOnly);
  check("has-money fallback yields job with no line items", jobs2.length === 1 && jobs2[0]?.total === 300);
  check("raw has-money fallback yields raw job", adapter.extractRawServiceJobsFromWorkOrder(moneyOnly).length === 1);

  const emptyEstimate: any = { id: "ord_3", status: "Estimate", totalCostCents: 0 };
  check("zero-money, no-items order yields no jobs", adapter.extractServiceJobsFromWorkOrder(emptyEstimate).length === 0);

  console.log("[shopmonkey-history] NIS job_index integration");
  const jobIndexWrites: any[] = [];
  const fakeDb: any = {
    collection(name: string) {
      if (name !== "job_index") throw new Error(`unexpected collection ${name}`);
      return {
        findOne: async () => null,
        insertOne: async (doc: any) => {
          jobIndexWrites.push(doc);
          return { insertedId: "x" };
        },
        updateOne: async (_f: any, update: any) => {
          jobIndexWrites.push(update.$set ?? update);
          return { upsertedCount: 1 };
        },
      };
    },
  };
  const service: any = new NormalizedIngestionService(fakeDb, "shopmonkey", 999, undefined, {
    dualWriteToJobIndex: true,
  });
  // Neutralize ACES enrichment (would hit DataOne).
  service.enrichVehicleWithAces = async (v: any) => v;
  service._acesBatchCache = new Map();

  const lines = service.buildShopmonkeyLinesByJob(orderWithItems);
  check("lines map keyed by raw job id", Array.isArray(lines.get("ord_1")));
  check("lines map keyed by title", Array.isArray(lines.get("Oil Change, Brake Pads")));
  const lg = lines.get("ord_1") ?? [];
  const labor = lg.find((l: any) => l.lineType === "labor");
  const part = lg.find((l: any) => l.lineType === "part");
  check("labor line carries hours", labor?.hours === 1.5);
  check("part line cents→dollars", part?.unitPrice === 50 && part?.extendedPrice === 50);
  check("part line keeps partNumber", part?.partNumber === "PH7317");

  // Terminal gate: estimate must NOT write.
  await service.writeToJobIndex(
    { ...orderWithItems, status: "Estimate", invoicedDate: undefined, completedDate: undefined, postedDate: undefined },
    adapter.extractServiceJobsFromWorkOrder(orderWithItems),
  );
  check("estimate order writes NO job_index rows", jobIndexWrites.length === 0, jobIndexWrites);

  // Invoiced order MUST write, with performedAt + mileage + lines + workOrderNumber.
  await service.writeToJobIndex(orderWithItems, adapter.extractServiceJobsFromWorkOrder(orderWithItems));
  check("invoiced order writes a job_index row", jobIndexWrites.length === 1);
  const row = jobIndexWrites[0] ?? {};
  check("row closedDate from invoicedDate", row.closedDate === "2026-07-01T00:00:00Z");
  check("row performedAt is a Date", row.performedAt instanceof Date);
  check("row mileage from mileageIn", row.mileage === 42000);
  check("row workOrderNumber from number", String(row.workOrderNumber) === "1001");
  check("row lines populated", Array.isArray(row.lines) && row.lines.length === 2, row.lines);
  check("row title", row.title === "Oil Change, Brake Pads");

  console.log("[shopmonkey-history] batched service-item attach under limiter pressure");
  const { attachServiceItemsBatched } = await import("@/lib/integrations/shopmonkey/ingest");
  // Simulate 120 orders across 30 customers where PER-ORDER fetching would
  // blow the limiter (only ~35 fetches tolerated before hard failure), but
  // per-customer batching stays comfortably within budget.
  const CUSTOMERS = 30;
  const ORDERS = 120;
  const pressuredOrders: any[] = Array.from({ length: ORDERS }, (_, i) => ({
    id: `o${i}`,
    customerId: `c${i % CUSTOMERS}`,
  }));
  let fetchCalls = 0;
  let flaky = true;
  const fetchServiceItems = async (_shopId: number, filter: any) => {
    fetchCalls++;
    if (fetchCalls > 35) throw new Error("rate limiter slot timeout");
    // First call for customer c0 fails transiently → retry must recover it.
    if (filter.customerId === "c0" && flaky) {
      flaky = false;
      throw new Error("transient 429");
    }
    const cIdx = Number(String(filter.customerId).slice(1));
    return pressuredOrders
      .filter((o) => o.customerId === filter.customerId)
      .map((o) => ({ id: `li-${o.id}`, type: "labor", order: { id: o.id }, hours: 1 }));
  };
  const stats = await attachServiceItemsBatched(999, pressuredOrders, {
    fetchServiceItems,
    log: () => {},
  });
  check("one fetch per customer group (+1 retry), not per order", fetchCalls === CUSTOMERS + 1, fetchCalls);
  check("all 120 orders attached despite limiter budget", stats.ordersAttached === ORDERS, stats);
  check("no failed groups after retry", stats.groupsFailed === 0, stats);
  check("every order carries its own lines", pressuredOrders.every((o) => o.serviceItems?.length === 1 && o.serviceItems[0].order.id === o.id));

  // Hard-failure visibility: a group that fails both attempts is reported.
  const failOrders: any[] = [{ id: "fx", customerId: "dead" }];
  const failStats = await attachServiceItemsBatched(999, failOrders, {
    fetchServiceItems: async () => { throw new Error("down"); },
    log: () => {},
  });
  check("persistently failed group is surfaced in stats", failStats.groupsFailed === 1 && failStats.ordersAttached === 0, failStats);
  check("failed order keeps serviceItems undefined (not silent [])", failOrders[0].serviceItems === undefined);

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll shopmonkey-history-ingest checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
