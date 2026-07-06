import { withExtensionErrorMarker } from "@/lib/extension-route-wrapper";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { validateExtensionToken, getUserShopIds, getAuthErrorStatus , buildAuthErrorBody } from "@/lib/extension-auth";
import { checkShopFeatureGate } from "@/lib/extension-route-guard";
import { scoreJob, buildSearchQuery, applyMinimumResults, extractVehicleSpecs, buildCorroborationCounts, ScoredJob, VehicleSpecs } from "@/lib/job-scoring";
import { getEnterpriseByShopId } from "@/lib/enterprise";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";
import { searchJobsCombined } from "@/lib/job-search-combined";
import { batchDecodeSquishes, toSquishPublic, VinReferenceData } from "@/lib/integrations/dataone-local";

const MODEL_VARIANTS: Record<string, string[]> = {
  "EXPEDITION": ["EXPEDITION", "EXPEDITION MAX"],
  "EXPEDITION MAX": ["EXPEDITION", "EXPEDITION MAX"],
  "EXPLORER": ["EXPLORER", "EXPLORER SPORT", "EXPLORER SPORT TRAC"],
  "TAHOE": ["TAHOE", "SUBURBAN"],
  "SUBURBAN": ["TAHOE", "SUBURBAN"],
  "YUKON": ["YUKON", "YUKON XL", "TAHOE", "SUBURBAN"],
  "YUKON XL": ["YUKON", "YUKON XL", "SUBURBAN"],
  "GRAND CHEROKEE": ["GRAND CHEROKEE", "GRAND CHEROKEE L"],
  "GRAND CHEROKEE L": ["GRAND CHEROKEE", "GRAND CHEROKEE L"],
  "WRANGLER": ["WRANGLER", "WRANGLER UNLIMITED"],
  "WRANGLER UNLIMITED": ["WRANGLER", "WRANGLER UNLIMITED"],
  "4RUNNER": ["4RUNNER", "GX460", "GX"],
  "TUNDRA": ["TUNDRA", "SEQUOIA"],
  "SEQUOIA": ["SEQUOIA", "TUNDRA"],
  "PILOT": ["PILOT", "MDX"],
  "MDX": ["MDX", "PILOT"],
};

function getModelVariants(model: string): string[] {
  const normalized = model.toUpperCase().trim();
  return MODEL_VARIANTS[normalized] || [normalized];
}

async function resolveVehicleContext(
  db: any,
  params: { year: string | null; make: string | null; model: string | null; engine: string | null; vin: string | null; roId: string | null; mosShopId: number | null; provider: string }
): Promise<{ year: string | null; make: string | null; model: string | null; engine: string | null; vin: string | null }> {
  let { year, make, model, engine, vin, roId, mosShopId, provider } = params;
  // Skip the WO lookup only when we already have a VIN (the only thing we
  // can't reliably reconstruct downstream) OR when we don't have the keys
  // to look it up. Older clients passed year/make/model without a VIN; in
  // that case we still want the WO lookup to populate the missing VIN so
  // DataOne decode can fire and ACES tiers can engage. Otherwise the
  // route silently returned dataOneEnhanced=false on every search.
  if (vin || !roId || !mosShopId) {
    return { year, make, model, engine, vin };
  }
  
  const workOrder = await db.collection("tekmetric_work_orders").findOne({
    shopId: { $in: [String(mosShopId), Number(mosShopId)] },
    workOrderId: String(roId)
  });
  
  if (workOrder) {
    year = year || workOrder.vehicleYear?.toString() || null;
    make = make || workOrder.vehicleMake || null;
    model = model || workOrder.vehicleModel || null;
    engine = engine || workOrder.vehicleEngine || null;
    vin = vin || workOrder.vehicleVin || workOrder.vin || null;
    console.log(`[Jobs Search] Resolved vehicle from WO ${roId}: ${year} ${make} ${model} VIN=${vin ? vin.slice(0,8)+'...' : 'none'}`);
  } else if (provider === "tekmetric") {
    console.log(`[Jobs Search] WO ${roId} not in cache, checking Tekmetric repair orders`);
    const tekRo = await db.collection("tekmetric_repair_orders").findOne({
      $or: [{ id: parseInt(roId) }, { id: String(roId) }]
    });
    if (tekRo?.vehicle) {
      year = year || tekRo.vehicle.year?.toString() || null;
      make = make || tekRo.vehicle.make || null;
      model = model || tekRo.vehicle.model || null;
      engine = engine || tekRo.vehicle.engine || null;
      vin = vin || tekRo.vehicle.vin || null;
      console.log(`[Jobs Search] Resolved vehicle from tekmetric_repair_orders: ${year} ${make} ${model} VIN=${vin ? vin.slice(0,8)+'...' : 'none'}`);
    }
  }
  return { year, make, model, engine, vin };
}

async function resolveSearchShopIds(
  db: any,
  mosShopId: number | null,
  isPlatformAdmin: boolean,
  userShopIds: number[]
): Promise<number[]> {
  if (!mosShopId) {
    return isPlatformAdmin ? [] : userShopIds;
  }
  
  const enterprise = await getEnterpriseByShopId(mosShopId);
  if (!enterprise || enterprise.shopIds.length <= 1) {
    return [mosShopId];
  }
  
  const shop = await db.collection("shops").findOne({ shopId: { $in: [Number(mosShopId), String(mosShopId)] } });
  const jobHistoryShopIds = shop?.preferences?.jobHistoryShopIds;
  
  if (Array.isArray(jobHistoryShopIds) && jobHistoryShopIds.length > 0) {
    const enterpriseSet = new Set(enterprise.shopIds.map(Number));
    const filtered = jobHistoryShopIds.map(Number).filter((id: number) => enterpriseSet.has(id));
    if (!filtered.includes(mosShopId)) filtered.push(mosShopId);
    console.log(`[Jobs Search] Enterprise search (custom): shops ${filtered.join(', ')}`);
    return filtered;
  }
  
  console.log(`[Jobs Search] Enterprise search (all): shops ${enterprise.shopIds.join(', ')}`);
  return enterprise.shopIds;
}

async function resolveDataOneSpecs(
  targetVin: string | null,
  jobs: any[]
): Promise<{ targetSpecs: VehicleSpecs | null; jobSpecsMap: Map<string, VehicleSpecs> }> {
  const jobSpecsMap = new Map<string, VehicleSpecs>();
  let targetSpecs: VehicleSpecs | null = null;

  const squishToVin = new Map<string, string>();
  if (targetVin && targetVin.length >= 11) {
    try {
      squishToVin.set(toSquishPublic(targetVin), targetVin);
    } catch {}
  }
  for (const job of jobs) {
    const jVin = job.vehicle?.vin;
    if (jVin && typeof jVin === 'string' && jVin.length >= 11) {
      try {
        const sq = toSquishPublic(jVin);
        if (!squishToVin.has(sq)) squishToVin.set(sq, jVin);
      } catch {}
    }
  }

  if (squishToVin.size === 0) return { targetSpecs, jobSpecsMap };

  try {
    const decoded = await batchDecodeSquishes([...squishToVin.keys()]);
    
    if (targetVin && targetVin.length >= 11) {
      const tSquish = toSquishPublic(targetVin);
      const tDecoded = decoded.get(tSquish);
      if (tDecoded) targetSpecs = extractVehicleSpecs(tDecoded);
    }

    for (const job of jobs) {
      const jVin = job.vehicle?.vin;
      if (jVin && typeof jVin === 'string' && jVin.length >= 11) {
        try {
          const sq = toSquishPublic(jVin);
          const jDecoded = decoded.get(sq);
          if (jDecoded) {
            const jobId = job._id?.toString() || `${job.shopId}-${job.workOrderId}-${job.job?.title}-${job.dataSource || ''}`;
            jobSpecsMap.set(jobId, extractVehicleSpecs(jDecoded));
          }
        } catch {}
      }
    }
  } catch (err) {
    console.error("[Jobs Search] DataOne specs resolution failed (non-blocking):", err);
  }

  return { targetSpecs, jobSpecsMap };
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

async function _GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const query = searchParams.get("q") || "";
    const smsShopId = searchParams.get("shopId");
    const roId = searchParams.get("roId");
    let year = searchParams.get("year");
    let make = searchParams.get("make");
    let model = searchParams.get("model");
    let engine = searchParams.get("engine");
    let vin = searchParams.get("vin");
    const limit = Math.min(parseInt(searchParams.get("limit") || "20"), 50);

    const auth = await validateExtensionToken(request);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json(buildAuthErrorBody(auth), { status: getAuthErrorStatus(auth), headers: corsHeaders });
    }

    const db = await getDb();
    const userShopIds = getUserShopIds(auth.user).map(id => parseInt(id));
    const isPlatformAdmin = auth.user.role === "platform_admin";

    let mosShopId: number | null = null;
    let provider: string = 'tekmetric';
    
    if (smsShopId) {
      const providerParam = new URL(request.url).searchParams.get("provider") || undefined;
      const shopResult = await findShopBySmsId(smsShopId, { userShopIds, isPlatformAdmin, providerHint: providerParam });
      if (shopResult) {
        mosShopId = shopResult.mosShopId;
        provider = shopResult.provider;
        console.log(`[Jobs Search] Resolved shop from SMS ID ${smsShopId} -> MOS shop ${mosShopId}`);
      }
    }
    
    if (!mosShopId && auth.user.shopId) {
      mosShopId = parseInt(auth.user.shopId);
      const shopDoc = await db.collection("shops").findOne(
        { shopId: { $in: [mosShopId, String(mosShopId)] } },
        { projection: { integrationProvider: 1, tekmetric: 1, protractor: 1, autoflow: 1 } }
      );
      if (shopDoc) {
        provider = shopDoc.integrationProvider 
          || (shopDoc.tekmetric?.shopId ? 'tekmetric' 
            : shopDoc.protractor?.connectionId ? 'protractor' 
            : shopDoc.autoflow?.domain ? 'autoflow' 
            : 'tekmetric');
      }
    }

    if (!query.trim()) {
      return NextResponse.json({ jobs: [] }, { headers: corsHeaders });
    }

    // Feature gate: requires `job_lookup`. Use the resolved mosShopId from
    // either the SMS lookup or the user's primary shop.
    if (mosShopId) {
      const denied = await checkShopFeatureGate(mosShopId, ["job_lookup"], {
        isPlatformAdmin,
        featureLabel: "Job Lookup",
        corsHeaders,
      });
      if (denied) return denied;
    }

    const [vehicleContext, searchShopIds] = await Promise.all([
      resolveVehicleContext(db, { year, make, model, engine, vin, roId, mosShopId, provider }),
      resolveSearchShopIds(db, mosShopId, isPlatformAdmin, userShopIds),
    ]);
    year = vehicleContext.year;
    make = vehicleContext.make;
    model = vehicleContext.model;
    engine = vehicleContext.engine;
    vin = vehicleContext.vin;
    
    console.log(`[Jobs Search] Query: "${query}", Y/M/M/E: ${year}/${make}/${model}/${engine}, VIN: ${vin ? vin.slice(0, 8) + '...' : 'none'}, shopIds: ${searchShopIds.join(',')}`);

    const { coreTokens } = buildSearchQuery(query);

    // Run the canonical Supabase (`normalized_service_jobs`) and legacy Mongo
    // (`job_index`) arms concurrently. We prefer the canonical PG result when it
    // returns rows quickly, but never block on the slow PG arm: the fast Mongo
    // fallback is served promptly when PG is empty or slow. See task #692.
    const combined = await searchJobsCombined(db, searchShopIds, coreTokens, {
      make: make || undefined,
      model: model || undefined,
      supabaseLimit: limit * 2,
      mongoLimit: limit * 5,
    });
    const jobs = combined.jobs;
    const supabaseResults = { length: combined.supabaseCount };
    const mongoResultCount = combined.mongoCount;

    console.log(`[Jobs Search] Served from supabase=${combined.supabaseCount} mongo=${mongoResultCount} total=${jobs.length} source=${combined.source}`);

    const { targetSpecs, jobSpecsMap } = await resolveDataOneSpecs(vin || null, jobs);
    
    if (targetSpecs) {
      console.log(`[Jobs Search] Target vehicle specs: GVWR=${targetSpecs.gvwrBand}, body=${targetSpecs.bodyType}, drive=${targetSpecs.driveType}, disp=${targetSpecs.displacement}`);
    }

    const targetVehicle = { year, make, model, engine, vin };
    const idFor = (job: any) =>
      job._id?.toString() || `${job.shopId}-${job.workOrderId}-${job.job?.title}-${job.dataSource || ''}`;
    const corroborationCounts = buildCorroborationCounts(jobs, idFor);
    const scoredJobs: ScoredJob[] = jobs.map(job => {
      const jobId = idFor(job);
      const jobSpecs = jobSpecsMap.get(jobId) || null;
      return scoreJob(job, targetVehicle, targetSpecs, jobSpecs, query, {
        currentShopId: mosShopId,
        corroboratingCount: corroborationCounts.get(jobId) ?? 1,
      });
    });
    
    if (scoredJobs.length > 0) {
      console.log(`[Jobs Search] Scoring results:`, scoredJobs.slice(0, 5).map(j => ({
        title: j.job?.title || j.title,
        score: j.matchScore,
        band: j.matchBand,
        gatePass: j.gatePass,
        crossClass: j.crossClassPenalized,
        reason: j.matchReason,
        vehicle: `${j.vehicle?.year} ${j.vehicle?.make} ${j.vehicle?.model}`,
      })));
    }
    
    // Same-VIN donors (jobs performed on this exact vehicle) always sort to
    // the very top, ahead of everything else, then by score. sameVinFastPath
    // scores 100 but so can an exact-ACES match, so we make the VIN match an
    // explicit primary sort key rather than relying on the score tie.
    //
    // When scores tie (e.g. several jobs at 100), break the tie by match
    // *quality* so a true Exact Fit / ACES match always ranks above a
    // heuristic "Great Match". Without this a same-make/different-model
    // heuristic 100 could sit above a genuine exact-fit 100.
    const qualityRank = (j: ScoredJob): number => {
      if (j.sameVinFastPath) return 6;
      const tier = (j.scoreBreakdown as any)?.acesTier;
      if (tier === "exact_aces") return 5;
      if (j.matchBand === "exact") return 4; // heuristic true exact (same make+model+year)
      if (tier === "engine_match") return 3;
      if (tier === "submodel_match") return 2;
      if (j.matchBand === "likely") return 1;
      return 0;
    };
    const eligible = applyMinimumResults(
      scoredJobs.sort((a, b) => {
        const aVin = a.sameVinFastPath ? 1 : 0;
        const bVin = b.sameVinFastPath ? 1 : 0;
        if (aVin !== bVin) return bVin - aVin;
        if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
        return qualityRank(b) - qualityRank(a);
      }),
      15,
      3
    );
    
    const uniqueJobs = new Map<string, ScoredJob>();
    for (const job of eligible) {
      const key = `${job.job?.title || job.title || ''}-${job.vehicle?.make || ''}-${job.vehicle?.model || ''}-${job.vehicle?.year || ''}`;
      const existing = uniqueJobs.get(key);
      if (!existing || existing.matchScore < job.matchScore) {
        uniqueJobs.set(key, job);
      }
    }

    const results = Array.from(uniqueJobs.values()).slice(0, limit);

    const resultShopIds = [...new Set(results.map((j: any) => j.shopId).filter(Boolean))];
    const shopLocationMap = new Map<number, string>();
    const shopLaborRateMap = new Map<number, number>();
    if (resultShopIds.length > 0) {
      const shopDocs = await db.collection("shops").find(
        { shopId: { $in: resultShopIds.flatMap((id: any) => [Number(id), String(id)]) } },
        { projection: { shopId: 1, locationIdentifier: 1, name: 1, cachedLaborRate: 1 } }
      ).toArray();
      for (const s of shopDocs) {
        shopLocationMap.set(s.shopId, s.locationIdentifier || s.name || `Shop ${s.shopId}`);
        if (s.cachedLaborRate) shopLaborRateMap.set(s.shopId, s.cachedLaborRate);
      }
    }

    const formattedJobs = results.map((job: any) => {
      const sourceType = job.metadata?.sourceType || "protractor";
      
      const lines = job.job?.lines || job.lines || [];
      const rawTotals = job.job?.totals || job.totals || {};
      
      const laborLines = lines.filter((l: any) => l.lineType === "labor");
      const partLines = lines.filter((l: any) => l.lineType === "part");
      
      const laborHours = laborLines.reduce((sum: number, l: any) => 
        sum + (parseFloat(l.hours) || parseFloat(l.quantity) || 0), 0);
      
      const calculatedPartsAmount = partLines.reduce((sum: number, l: any) => {
        const qty = l.quantity || 1;
        const price = l.unitPrice || l.extendedPrice || 0;
        return sum + (qty * price);
      }, 0);
      
      const calculatedLaborAmount = laborLines.reduce((sum: number, l: any) => {
        const price = l.unitPrice || l.extendedPrice || 0;
        return sum + price;
      }, 0);
      
      const totalAmount = rawTotals.totalAmount || 0;
      const partsAmount = rawTotals.partsAmount || calculatedPartsAmount;
      let laborAmount = rawTotals.laborAmount || calculatedLaborAmount;
      if (laborAmount === 0 && totalAmount > 0 && totalAmount > partsAmount) {
        laborAmount = Math.round((totalAmount - partsAmount) * 100) / 100;
      }

      const allPartPricesZero = partLines.length > 0 && partLines.every((l: any) => !(l.unitPrice || l.extendedPrice));
      const totalPartsQty = partLines.reduce((s: number, l: any) => s + (l.quantity || 1), 0);

      const jobTitle = job.job?.title || job.title || "Job";
      let laborItems = laborLines.map((l: any) => ({
        name: l.description,
        hours: parseFloat(l.hours) || parseFloat(l.quantity) || 0
      }));
      if (laborItems.length === 0 && laborAmount > 0) {
        const shopRate = shopLaborRateMap.get(job.shopId) || 150;
        const estHours = rawTotals.laborHours || Math.round(laborAmount / shopRate * 10) / 10;
        laborItems = [{ name: jobTitle, hours: estHours }];
      }
      
      return {
        _id: job._id.toString(),
        title: jobTitle,
        description: job.job?.description,
        code: job.job?.code,
        vehicle: job.vehicle,
        workOrderNumber: job.workOrderNumber,
        lines,
        laborItems,
        parts: partLines.map((l: any) => {
          let retail = l.unitPrice || l.extendedPrice || 0;
          if (retail === 0 && allPartPricesZero && partsAmount > 0 && totalPartsQty > 0) {
            retail = Math.round((partsAmount / totalPartsQty) * 100) / 100;
          }
          return {
            name: l.description,
            partNumber: l.partNumber,
            brand: l.manufacturer,
            quantity: l.quantity || 1,
            cost: l.cost || 0,
            retail
          };
        }),
        totals: {
          laborHours: rawTotals.laborHours || laborHours || (laborItems.length > 0 ? laborItems.reduce((s: number, l: any) => s + (l.hours || 0), 0) : 0),
          laborAmount,
          partsAmount,
          totalAmount: totalAmount || (laborAmount + partsAmount),
        },
        matchScore: job.matchScore,
        matchBand: job.matchBand,
        matchBandLabel: job.matchBandLabel,
        matchReason: job.matchReason,
        acesTier: job.scoreBreakdown?.acesTier ?? null,
        sameVin: job.sameVinFastPath ?? false,
        lowConfidence: job.lowConfidence || false,
        crossClassPenalized: job.crossClassPenalized || false,
        source: sourceType,
        shopId: job.shopId || null,
        location: shopLocationMap.get(job.shopId) || null,
      };
    });

    return NextResponse.json({ 
      jobs: formattedJobs,
      total: formattedJobs.length,
      query,
      dataOneEnhanced: !!targetSpecs,
      stats: {
        totalFound: jobs.length,
        fromSupabase: supabaseResults.length,
        gatesFailed: scoredJobs.filter(j => !j.gatePass).length,
        belowThreshold: scoredJobs.filter(j => j.gatePass && j.matchScore < 35).length,
        returned: formattedJobs.length,
      }
    }, { headers: corsHeaders });

  } catch (error: any) {
    console.error("[Extension Jobs Search] Error:", error);
    if (error?.codeName === 'MaxTimeMSExpired' || error?.code === 50) {
      return NextResponse.json(
        { error: "Search timed out. Try a more specific search term.", jobs: [], total: 0 },
        { status: 200, headers: corsHeaders }
      );
    }
    return NextResponse.json(
      { error: "Search failed" },
      { status: 500, headers: corsHeaders }
    );
  }
}

// Task #510: per-shop error-rate alerting — wrap all extension handlers
export const GET = withExtensionErrorMarker(_GET as any);
