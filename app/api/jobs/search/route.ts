import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { getEnterpriseByShopId } from "@/lib/enterprise";
import { getFeatureEntitlements } from "@/lib/featureResolver";
import { searchJobsCombined } from "@/lib/job-search-combined";
import { scoreJob, buildSearchQuery, applyMinimumResults, buildCorroborationCounts } from "@/lib/job-scoring";
import { batchDecodeSquishes, toSquishPublic } from "@/lib/integrations/dataone-local";
import { resolveJobSearchSpecs } from "@/lib/job-search-specs";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);
  
  const entitlements = await getFeatureEntitlements(shopId);
  if (!entitlements.canUseFeature("job_lookup")) {
    return NextResponse.json({ 
      error: "Job Lookup is not available on your current plan",
      code: "FEATURE_NOT_AVAILABLE",
      upgradeRequired: true,
      currentPlan: entitlements.billing.plan,
    }, { status: 402 });
  }
  
  const { searchParams } = new URL(req.url);
  
  const query = searchParams.get("q") || "";
  const vehicleYear = searchParams.get("year");
  const vehicleMake = searchParams.get("make");
  const vehicleModel = searchParams.get("model");
  const vehicleEngine = searchParams.get("engine");
  const strictModel = searchParams.get("strictModel") === "true";
  const limit = Math.min(parseInt(searchParams.get("limit") || "20"), 50);

  if (!query && !vehicleMake) {
    return NextResponse.json({ 
      error: "Please provide a search query (q) or vehicle make" 
    }, { status: 400 });
  }

  const db = await getDb();
  
  // Check if shop is part of an enterprise - if so, search enterprise shops based on preferences
  let searchShopIds: number[] = [shopId];
  const enterprise = await getEnterpriseByShopId(shopId);
  if (enterprise && enterprise.shopIds.length > 1) {
    // Check shop preferences for job history location selection
    const shop = await db.collection("shops").findOne({ shopId: { $in: [Number(shopId), String(shopId)] } });
    const jobHistoryShopIds = shop?.preferences?.jobHistoryShopIds;
    
    if (Array.isArray(jobHistoryShopIds) && jobHistoryShopIds.length > 0) {
      // Use the shop's selected locations (must be within enterprise)
      const enterpriseSet = new Set(enterprise.shopIds.map(Number));
      searchShopIds = jobHistoryShopIds.map(Number).filter((id: number) => enterpriseSet.has(id));
      if (!searchShopIds.includes(shopId)) {
        searchShopIds.push(shopId);
      }
      console.log(`[Jobs Search] Enterprise search (custom): shops ${searchShopIds.join(', ')}`);
    } else {
      // Default: search all enterprise shops
      searchShopIds = enterprise.shopIds;
      console.log(`[Jobs Search] Enterprise search (all): shops ${searchShopIds.join(', ')}`);
    }
  }
  
  // Build shop lookup map for location names
  const shopDocs = await db.collection("shops")
    .find({ shopId: { $in: searchShopIds.flatMap(id => [Number(id), String(id)]) } })
    .project({ shopId: 1, name: 1, locationIdentifier: 1 })
    .toArray();
  
  const shopLookup = new Map<number, { name: string; locationIdentifier: string | null }>();
  for (const s of shopDocs) {
    shopLookup.set(Number(s.shopId), {
      name: s.name || `Shop ${s.shopId}`,
      locationIdentifier: s.locationIdentifier || null,
    });
  }
  
  const { coreTokens } = buildSearchQuery(query);

  // NOTE: When strictModel is false (default), model is NOT used as a hard filter -
  // it's used for scoring only. This allows "oil change on HHR" to find results
  // from other Chevrolet models (Trax, Cruze, etc.) when no exact HHR jobs exist.
  // When strictModel=true (used by New Work Order history tab), model IS a hard
  // filter so only jobs from the same vehicle model are shown.

  // Run the canonical Supabase (`normalized_service_jobs`) and legacy Mongo
  // (`job_index`) arms concurrently. We prefer the canonical PG result when it
  // returns rows quickly, but never block on the slow PG arm: the fast Mongo
  // fallback is served promptly when PG is empty or slow. See task #692.
  const combined = await searchJobsCombined(db, searchShopIds, coreTokens, {
    make: vehicleMake || undefined,
    model: vehicleModel || undefined,
    supabaseLimit: limit * 2,
    mongoLimit: limit * 5,
    strictModel,
  });
  const jobs = combined.jobs;
  const supabaseResults = { length: combined.supabaseCount };
  const mongoResultCount = combined.mongoCount;

  console.log(`[Jobs Search] Served from supabase=${combined.supabaseCount} mongo=${mongoResultCount} total=${jobs.length} source=${combined.source}`);
  
  const vehicleVin = searchParams.get("vin");

  const targetVehicle = { year: vehicleYear, make: vehicleMake, model: vehicleModel, engine: vehicleEngine, vin: vehicleVin };
  const idFor = (job: any) =>
    job._id?.toString() || `${job.shopId}-${job.workOrderId}-${job.job?.title}-${job.dataSource || ''}`;

  const { targetSpecs, jobSpecsMap } = await resolveJobSearchSpecs({
    targetVin: vehicleVin,
    jobs,
    idFor,
    toSquish: toSquishPublic,
    batchDecode: batchDecodeSquishes,
    logPrefix: "[Jobs Search]",
  });
  const corroborationCounts = buildCorroborationCounts(jobs, idFor);
  const scoredJobs = jobs.map((job: any) => {
    const jobId = idFor(job);
    const jobSpecs = jobSpecsMap.get(jobId) || null;
    const scored = scoreJob(job, targetVehicle, targetSpecs, jobSpecs, query, {
      currentShopId: shopId,
      corroboratingCount: corroborationCounts.get(jobId) ?? 1,
    });
    
    const jobShopId = Number(job.shopId);
    const isCurrentLocation = jobShopId === shopId;
    const shopInfo = shopLookup.get(jobShopId);
    const locationName = shopInfo?.locationIdentifier || shopInfo?.name || `Shop ${jobShopId}`;
    
    return {
      ...scored,
      isCurrentLocation,
      locationName,
      locationShopId: jobShopId,
    };
  });
  
  const eligible = applyMinimumResults(
    scoredJobs.sort((a, b) => b.matchScore - a.matchScore),
    15,
    3
  );

  const uniqueJobs = new Map<string, typeof eligible[0]>();
  for (const job of eligible) {
    const key = `${job.job?.title || ''}-${job.vehicle?.make || ''}-${job.vehicle?.model || ''}-${job.vehicle?.year || ''}`;
    const existing = uniqueJobs.get(key);
    if (!existing || existing.matchScore < job.matchScore) {
      uniqueJobs.set(key, job);
    }
  }

  const results = Array.from(uniqueJobs.values()).slice(0, limit);
  
  return NextResponse.json({
    ok: true,
    query,
    vehicle: { year: vehicleYear, make: vehicleMake, model: vehicleModel, engine: vehicleEngine },
    dataOneEnhanced: !!targetSpecs,
    results,
    stats: {
      totalFound: jobs.length,
      fromSupabase: supabaseResults.length,
      gatesFailed: scoredJobs.filter(j => !j.gatePass).length,
      belowThreshold: scoredJobs.filter(j => j.gatePass && j.matchScore < 35).length,
      returned: results.length,
    },
  });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  
  const { query, vehicle, limit = 20 } = body;
  
  const searchParams = new URLSearchParams();
  if (query) searchParams.set("q", query);
  if (vehicle?.year) searchParams.set("year", String(vehicle.year));
  if (vehicle?.make) searchParams.set("make", vehicle.make);
  if (vehicle?.model) searchParams.set("model", vehicle.model);
  if (vehicle?.engine) searchParams.set("engine", vehicle.engine);
  searchParams.set("limit", String(limit));
  
  const url = new URL(req.url);
  url.search = searchParams.toString();
  
  const newReq = new NextRequest(url, { headers: req.headers });
  return GET(newReq);
}
