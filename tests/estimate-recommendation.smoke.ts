/**
 * Task #1274 resolver contract tests.
 *
 * These tests stub every persistence/provider seam.  They exercise the
 * security and precedence rules without reading or writing production data:
 *
 *   npx tsx tests/estimate-recommendation.smoke.ts
 */
import {
  __deps,
  rehydrateRecommendationSelection,
  resolveAuthorizedHistoryShopIds,
  resolveRecommendation,
  normalizeCandidateLines,
  serviceIdentity,
  serviceMatch,
} from "../lib/estimate-assist/recommendation-resolver";
import { findEnrichedCannedJobs } from "../lib/data/repositories/canned-jobs";
import {
  __deps as recommendationRepositoryDeps,
  findRecommendationCachedCatalogs,
} from "../lib/data/repositories/recommendation-caches";

let failed = 0;
function ok(name: string, condition: boolean, detail?: string) {
  if (condition) console.log(`  ✓ ${name}`);
  else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const original = { ...__deps };

async function run() {
  console.log("estimate recommendation resolver");

  const canned = {
    shopId: 42,
    source: "enriched",
    listSource: "cannedjob",
    fetchedAt: new Date(),
    items: [
      {
        ID: "fluid-1",
        Title: "Brake Fluid Flush",
        ServicePackageLines: {
          ItemCollection: [
            { Type: "Labor", Description: "Brake fluid flush", Quantity: 0.7, Price: 120, Total: 84 },
            { Type: "Material", Description: "DOT 4 Brake Fluid", Quantity: 1, Price: 18, Total: 18 },
          ],
        },
      },
      {
        ID: "pads-1",
        Title: "Front Brake Pad Replacement",
        ServicePackageLines: {
          ItemCollection: [
            { Type: "Labor", Description: "Replace pads", Quantity: 1, Price: 120, Total: 120 },
          ],
        },
      },
    ],
  } as any;

  __deps.getEnterpriseByShopId = async () => ({ shopIds: [42, 77] }) as any;
  __deps.getDb = async () => ({
    collection: () => ({
      findOne: async () => ({ preferences: { jobHistoryShopIds: [77] } }),
    }),
  }) as any;
  __deps.findCannedJobsCacheByShopId = async () => canned;
  __deps.searchHistory = async () => ({
    ok: true,
    source: "none",
    jobs: [],
  });
  __deps.fetchCannedDetail = async () => ({ ok: false, error: "not needed" });

  const scoped = await resolveAuthorizedHistoryShopIds(42);
  ok("enterprise history is preference-scoped and retains current shop", JSON.stringify(scoped.shopIds) === JSON.stringify([77, 42]), JSON.stringify(scoped.shopIds));

  const fluid = await resolveRecommendation(
    42,
    { suggestedJobId: "brake-fluid-flush", suggestedJobTitle: "Brake Fluid Flush" },
    { year: 2020, make: "Honda", model: "Civic" },
  );
  ok("canned cache takes precedence", fluid.status === "candidates");
  ok("canned candidate keeps real labor and part lines", fluid.candidates[0]?.lines.length === 2);
  ok("canned source identity is client-safe", fluid.candidates[0]?.source.kind === "canned" && fluid.candidates[0]?.source.shopId === 42);
  ok("fluid recommendation never resolves to brake pads", !fluid.candidates.some((candidate) => /pad/i.test(candidate.title)));
  ok("configured service vocabulary recognizes provider brake-fluid phrasing", serviceIdentity(null, "BG Brake System Service") === "brake_fluid");
  ok("unmapped service identities require title evidence", serviceMatch(
    serviceIdentity(null, "Water Pump"),
    serviceIdentity(null, "Oil Filter"),
    "Water Pump",
    "Oil Filter",
  ) === "none");
  const laborHours = normalizeCandidateLines({
    lines: [{ Type: "Labor", Description: "Water pump labor", Quantity: 1, Hours: 2.5, UnitPrice: 100 }],
  });
  ok("history labor hours become write quantity", laborHours.lines[0]?.quantity === 2.5 && laborHours.lines[0]?.extendedPrice === 250);

  __deps.findCannedJobsCacheByShopId = async () => null;
  __deps.getDb = async () => ({
    collection: (name: string) => ({
      findOne: async () => {
        if (name === "shops") return { tekmetric: { shopId: 987 } };
        if (name === "tekmetric_canned_jobs_cache") {
          return {
            shopId: 987,
            cannedJobs: [{ id: "tm-1", name: "Coolant Flush", labor: [{ description: "Drain and fill", quantity: 1, unitPrice: 90, extendedPrice: 90 }] }],
          };
        }
        if (name === "shopware_canned_jobs_cache") {
          return { shopId: 42, items: [{ id: "sw-1", title: "Oil Change", lines: [] }] };
        }
        return null;
      },
      find: () => ({ limit: () => ({ toArray: async () => [] }) }),
    }),
  }) as any;
  const providerCatalogs = await __deps.findCannedCatalogsByShopId(42);
  ok("cached catalog orchestration includes Tekmetric provider rows", providerCatalogs.some((catalog) => catalog.sourceSystem === "tekmetric" && catalog.items[0]?.id === "tm-1"));
  ok("cached catalog orchestration includes Shop-Ware provider rows", providerCatalogs.some((catalog) => catalog.sourceSystem === "shopware" && catalog.items[0]?.id === "sw-1"));

  const enrichedRows = Array.from({ length: 600 }, (_, index) => ({ id: index }));
  let requestedCannedLimit: number | undefined;
  const cannedCursor = {
    limit: (limit: number) => {
      requestedCannedLimit = limit;
      return { toArray: async () => enrichedRows.slice(0, limit) };
    },
    toArray: async () => enrichedRows,
  };
  const cannedDb = {
    collection: () => ({ find: () => cannedCursor }),
  } as any;
  const unboundedEnriched = await findEnrichedCannedJobs(42, { dbOverride: cannedDb });
  ok("enriched canned-job repository preserves unbounded default reads", unboundedEnriched.length === 600 && requestedCannedLimit === undefined);
  const boundedEnriched = await findEnrichedCannedJobs(42, { dbOverride: cannedDb, limit: 500 });
  ok("enriched canned-job repository applies an explicit read limit", boundedEnriched.length === 500 && requestedCannedLimit === 500);
  let recommendationCannedLimit: number | undefined;
  const recommendationDb = {
    collection: (name: string) => name === "canned_jobs"
      ? {
          find: () => ({
            limit: (limit: number) => {
              recommendationCannedLimit = limit;
              return { toArray: async () => enrichedRows.slice(0, limit) };
            },
          }),
        }
      : {},
  } as any;
  const recommendationCatalogs = await findRecommendationCachedCatalogs(42, { dbOverride: recommendationDb });
  ok("recommendation cached-catalog reads use the explicit canned-job bound", recommendationCatalogs.some((catalog) => catalog.source === "enriched_cache" && catalog.items.length === 500) && recommendationCannedLimit === 500);

  __deps.findCannedCatalogsByShopId = async () => [{
    sourceSystem: "tekmetric",
    shopId: 42,
    items: [{
      id: "tm-aggregate",
      name: "Coolant Flush",
      sourceSystem: "tekmetric",
      laborAmount: 12500,
      partsAmount: 3000,
      lines: [
        { lineType: "labor", description: "Labor", quantity: 1, unitPrice: 12500, extendedPrice: 12500 },
        { lineType: "part", description: "Parts", quantity: 1, unitPrice: 3000, extendedPrice: 3000 },
      ],
    }],
  }];
  __deps.searchHistory = async () => ({
    ok: true,
    source: "mongo",
    jobs: [{
      _id: "history-coolant",
      shopId: 42,
      vehicle: { year: 2020, make: "Honda", model: "Civic" },
      job: { title: "Coolant Flush" },
      lines: [{ lineType: "labor", description: "Drain and fill", quantity: 1, unitPrice: 90, extendedPrice: 90 }],
    }],
  });
  const aggregateFallback = await resolveRecommendation(42, { suggestedJobTitle: "Coolant Flush" });
  ok(
    "Tekmetric aggregate-only cents rows do not take precedence over history",
    aggregateFallback.status === "candidates" &&
      aggregateFallback.candidates[0]?.source.kind === "history" &&
      aggregateFallback.warnings.some((item) => item.code === "incomplete_canned_catalog"),
  );
  __deps.findCannedCatalogsByShopId = async () => [{
    sourceSystem: "shopware",
    shopId: 42,
    items: [{ id: "sw-aggregate", title: "Coolant Flush", lines: [] }],
  }];
  const thinShopwareFallback = await resolveRecommendation(42, { suggestedJobTitle: "Coolant Flush" });
  ok(
    "unhydratable Shop-Ware thin rows do not take precedence over history",
    thinShopwareFallback.status === "candidates" &&
      thinShopwareFallback.candidates[0]?.source.kind === "history" &&
      thinShopwareFallback.warnings.some((item) => item.code === "incomplete_canned_catalog"),
  );
  __deps.findCannedCatalogsByShopId = async () => [{
    sourceSystem: "tekmetric",
    shopId: 42,
    items: [{
      id: "tm-aggregate",
      name: "Coolant Flush",
      sourceSystem: "tekmetric",
      laborAmount: 12500,
      partsAmount: 3000,
      lines: [
        { lineType: "labor", description: "Labor", quantity: 1, unitPrice: 12500, extendedPrice: 12500 },
        { lineType: "part", description: "Parts", quantity: 1, unitPrice: 3000, extendedPrice: 3000 },
      ],
    }],
  }];
  const thinTekmetricSelection = await rehydrateRecommendationSelection(42, {
    source: { kind: "canned", shopId: 42, id: "tm-aggregate", sourceSystem: "tekmetric" },
  });
  ok(
    "unhydratable Tekmetric detail is unavailable",
    !thinTekmetricSelection.ok && thinTekmetricSelection.code === "UNAVAILABLE",
  );

  __deps.findCannedCatalogsByShopId = async () => [{
    sourceSystem: "tekmetric",
    shopId: 42,
    items: [{
      id: "tm-real",
      name: "Coolant Flush",
      sourceSystem: "tekmetric",
      labor: [{ description: "Drain and fill", quantity: 1, unitPrice: 12500, extendedPrice: 12500 }],
      parts: [{ description: "Coolant", quantity: 1, unitPrice: 3000, extendedPrice: 3000 }],
    }],
  }];
  const normalizedTekmetric = await resolveRecommendation(42, { suggestedJobTitle: "Coolant Flush" });
  ok(
    "Tekmetric real line prices normalize cents to dollars",
    normalizedTekmetric.status === "candidates" &&
      normalizedTekmetric.candidates[0]?.source.kind === "canned" &&
      normalizedTekmetric.candidates[0]?.lines[0]?.unitPrice === 125 &&
      normalizedTekmetric.candidates[0]?.lines[1]?.unitPrice === 30,
  );
  __deps.findCannedCatalogsByShopId = original.findCannedCatalogsByShopId;

  __deps.findCannedJobsCacheByShopId = async () => ({
    shopId: 42,
    fetchedAt: new Date(),
    items: [],
  } as any);
  __deps.searchHistory = async (shopIds) => ({
    ok: true,
    source: "mongo",
    jobs: [{
      _id: "history-1",
      shopId: shopIds[0],
      workOrderId: "wo-1",
      workOrderNumber: "100",
      vehicle: { year: 2020, make: "Honda", model: "Civic" },
      job: { title: "Brake Fluid Flush", description: "History" },
      lines: [
        { lineType: "labor", description: "Flush brake system", quantity: 0.7, unitPrice: 100, extendedPrice: 70 },
      ],
    }],
  });
  const historical = await resolveRecommendation(
    42,
    { suggestedJobTitle: "Brake Fluid Flush" },
    { year: 2020, make: "Honda", model: "Civic" },
  );
  ok("empty canned cache falls back to history", historical.status === "candidates" && historical.candidates[0]?.source.kind === "history");
  ok("historical candidate retains existing scorer output", historical.candidates[0]?.relevance.historicalScore != null);

  const selected = await rehydrateRecommendationSelection(42, {
    source: historical.candidates[0]!.source,
  }, { year: 2020, make: "Honda", model: "Civic" });
  ok("selected history is rehydrated from the server search", selected.ok && selected.recommendation.lines.length === 1);

  __deps.findCannedJobsCacheByShopId = async () => ({
    ...canned,
    items: [{ ID: "basic-1", Title: "Brake Fluid Flush" }],
  } as any);
  let hydratedCalls = 0;
  __deps.fetchCannedDetail = async () => {
    hydratedCalls += 1;
    return {
      ok: true,
      detail: {
        ID: "basic-1",
        Title: "Brake Fluid Flush",
        ServicePackageLines: {
          ItemCollection: [
            { Type: "Labor", Description: "Flush brake system", Quantity: 0.7, Price: 100, Total: 70 },
          ],
        },
      },
    };
  };
  const hydratedCanned = await rehydrateRecommendationSelection(42, {
    source: { kind: "canned", shopId: 42, id: "basic-1", listSource: "cannedjob" },
  });
  ok("selected basic canned row hydrates one detail item", hydratedCanned.ok && hydratedCalls === 1 && hydratedCanned.recommendation.lines.length === 1);
  const preview = await resolveRecommendation(
    42,
    { suggestedJobTitle: "Brake Fluid Flush" },
    {},
    {
      mode: "preview",
      selection: {
        source: { kind: "canned", shopId: 42, id: "basic-1", listSource: "cannedjob" },
      },
    },
  );
  ok("selected-detail preview returns the rehydrated candidate without a write", preview.status === "candidates" && preview.candidates[0]?.lines.length === 1);
  __deps.fetchCannedDetail = async () => ({
    ok: true,
    detail: { ID: "basic-1", Title: "Brake Fluid Flush" },
  });
  const unusablePreview = await resolveRecommendation(
    42,
    { suggestedJobTitle: "Brake Fluid Flush" },
    {},
    {
      mode: "preview",
      selection: {
        source: { kind: "canned", shopId: 42, id: "basic-1", listSource: "cannedjob" },
      },
    },
  );
  ok(
    "selected-detail preview returns an explicit unusable candidate warning",
    unusablePreview.status === "candidates" &&
      unusablePreview.candidates[0]?.lines.length === 0 &&
      unusablePreview.candidates[0]?.warnings.some((item) => item.code === "missing_lines"),
  );
  __deps.fetchCannedDetail = async () => ({ ok: false });
  const failedPreview = await resolveRecommendation(
    42,
    { suggestedJobTitle: "Brake Fluid Flush" },
    {},
    {
      mode: "preview",
      selection: {
        source: { kind: "canned", shopId: 42, id: "basic-1", listSource: "cannedjob" },
      },
    },
  );
  ok("selected-detail fetch failures are unavailable", failedPreview.status === "unavailable");

  const crossShop = await rehydrateRecommendationSelection(999, {
    source: { ...fluid.candidates[0]!.source, shopId: 42 },
  });
  ok("cross-shop canned selection is denied", !crossShop.ok && crossShop.code === "FORBIDDEN");

  __deps.findCannedCatalogsByShopId = async () => {
    throw new Error("canned cache unavailable");
  };
  __deps.searchHistory = async () => ({ ok: true, source: "none", jobs: [] });
  const cacheAndHistoryUnavailable = await resolveRecommendation(42, { suggestedJobTitle: "Brake Fluid Flush" });
  ok(
    "canned cache failure plus empty history is unavailable",
    cacheAndHistoryUnavailable.status === "unavailable",
  );

  __deps.findCannedCatalogsByShopId = async () => [];
  __deps.searchHistory = async () => ({
    ok: true,
    source: "mongo",
    jobs: [{
      _id: "diesel-f250-water-pump",
      shopId: 42,
      vehicle: { year: 2020, make: "Ford", model: "F-250", engine: "6.7L Diesel" },
      job: { title: "Water Pump" },
      lines: [{ lineType: "labor", description: "Water pump labor", quantity: 1, unitPrice: 100, extendedPrice: 100 }],
    }],
  });
  const gatedHistory = await resolveRecommendation(
    42,
    { suggestedJobTitle: "Water Pump" },
    { year: 2020, make: "Ford", model: "F-150", engine: "3.5L Gasoline" },
  );
  ok("history scorer gate failures exclude vehicle candidates", gatedHistory.status === "no_match" && gatedHistory.candidates.length === 0);

  const productionResolverGetDb = __deps.getDb;
  const productionResolverEnterprise = __deps.getEnterpriseByShopId;
  const productionResolverCatalogs = __deps.findCannedCatalogsByShopId;
  const productionResolverSearchHistory = __deps.searchHistory;
  const productionResolverSearchCombined = __deps.searchJobsCombined;
  const productionRepositoryGetDb = recommendationRepositoryDeps.getDb;
  const productionRepositorySearchCombined = recommendationRepositoryDeps.searchJobsCombined;
  const productionMongoDb = { collection: () => ({}) } as any;
  const productionHistoryJob = {
    _id: "production-history-1",
    shopId: 42,
    workOrderId: "wo-production",
    vehicle: { year: 2020, make: "Honda", model: "Civic" },
    job: { title: "Brake Fluid Flush", description: "Mongo fallback" },
    lines: [{ lineType: "labor", description: "Flush brake system", quantity: 0.7, unitPrice: 100, extendedPrice: 70 }],
  };
  let productionSearchDb: unknown;
  __deps.getDb = async () => null;
  __deps.getEnterpriseByShopId = async () => null;
  __deps.findCannedCatalogsByShopId = async () => [];
  __deps.searchJobsCombined = async (db) => {
    productionSearchDb = db;
    return {
      jobs: [productionHistoryJob],
      supabaseCount: 0,
      mongoCount: 1,
      source: "mongo" as const,
      diagnostics: { supabaseTimedOut: true },
    };
  };
  recommendationRepositoryDeps.getDb = async () => productionMongoDb;
  __deps.searchHistory = original.searchHistory;
  const productionDefaultResolution = await resolveRecommendation(
    42,
    { suggestedJobTitle: "Brake Fluid Flush" },
    { year: 2020, make: "Honda", model: "Civic" },
  );
  ok(
    "production-default history wiring gives Mongo a real repository handle",
    productionSearchDb === productionMongoDb &&
      productionDefaultResolution.status === "candidates" &&
      productionDefaultResolution.candidates[0]?.source.kind === "history",
  );
  const productionRehydrated = await rehydrateRecommendationSelection(
    42,
    { source: productionDefaultResolution.candidates[0]!.source },
    { year: 2020, make: "Honda", model: "Civic" },
  );
  ok(
    "Mongo history fallback supports selected rehydration while PG is slow",
    productionRehydrated.ok && productionRehydrated.recommendation.lines.length === 1,
  );
  __deps.getDb = productionResolverGetDb;
  __deps.getEnterpriseByShopId = productionResolverEnterprise;
  __deps.findCannedCatalogsByShopId = productionResolverCatalogs;
  __deps.searchHistory = productionResolverSearchHistory;
  __deps.searchJobsCombined = productionResolverSearchCombined;
  recommendationRepositoryDeps.getDb = productionRepositoryGetDb;
  recommendationRepositoryDeps.searchJobsCombined = productionRepositorySearchCombined;

  __deps.searchJobsCombined = async () => ({
    jobs: [],
    supabaseCount: 0,
    mongoCount: 0,
    source: "none" as const,
    diagnostics: { mongoError: "database unavailable" },
  });
  __deps.searchHistory = original.searchHistory;
  const unavailableHistory = await __deps.searchHistory([42], "Brake Fluid Flush", {});
  ok("history orchestration exposes combined-search failures", !unavailableHistory.ok && /database unavailable/.test(unavailableHistory.error || ""));
}

run()
  .catch((error) => {
    failed += 1;
    console.error(error);
  })
  .finally(() => {
    Object.assign(__deps, original);
    if (failed > 0) process.exit(1);
    console.log("\nAll assertions passed");
  });
