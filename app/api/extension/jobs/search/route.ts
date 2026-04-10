import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { validateExtensionToken, getUserShopIds, getAuthErrorStatus } from "@/lib/extension-auth";
import { scoreJob, buildSearchQuery, STOPWORDS, ScoredJob } from "@/lib/job-scoring";
import { getEnterpriseByShopId } from "@/lib/enterprise";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";
import { searchNormalizedCollections } from "@/lib/normalized-job-search";

// Model variants that share platforms and should cross-reference
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

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function resolveVehicleContext(
  db: any,
  params: { year: string | null; make: string | null; model: string | null; engine: string | null; roId: string | null; mosShopId: number | null; provider: string }
): Promise<{ year: string | null; make: string | null; model: string | null; engine: string | null }> {
  let { year, make, model, engine, roId, mosShopId, provider } = params;
  if (year || make || model || !roId || !mosShopId) {
    return { year, make, model, engine };
  }
  
  const workOrder = await db.collection("tekmetric_work_orders").findOne({
    shopId: { $in: [String(mosShopId), Number(mosShopId)] },
    workOrderId: String(roId)
  });
  
  if (workOrder) {
    year = workOrder.vehicleYear?.toString() || null;
    make = workOrder.vehicleMake || null;
    model = workOrder.vehicleModel || null;
    engine = workOrder.vehicleEngine || null;
    console.log(`[Jobs Search] Resolved vehicle from WO ${roId}: ${year} ${make} ${model}`);
  } else if (provider === "tekmetric") {
    console.log(`[Jobs Search] WO ${roId} not in cache, checking Tekmetric repair orders`);
    const tekRo = await db.collection("tekmetric_repair_orders").findOne({
      $or: [{ id: parseInt(roId) }, { id: String(roId) }]
    });
    if (tekRo?.vehicle) {
      year = tekRo.vehicle.year?.toString() || null;
      make = tekRo.vehicle.make || null;
      model = tekRo.vehicle.model || null;
      engine = tekRo.vehicle.engine || null;
      console.log(`[Jobs Search] Resolved vehicle from tekmetric_repair_orders: ${year} ${make} ${model}`);
    }
  }
  return { year, make, model, engine };
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

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const query = searchParams.get("q") || "";
    const smsShopId = searchParams.get("shopId");
    const roId = searchParams.get("roId");
    let year = searchParams.get("year");
    let make = searchParams.get("make");
    let model = searchParams.get("model");
    let engine = searchParams.get("engine");
    const limit = Math.min(parseInt(searchParams.get("limit") || "20"), 50);

    const auth = await validateExtensionToken(request);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json({ error: auth.error || "Unauthorized" }, { status: getAuthErrorStatus(auth), headers: corsHeaders });
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
    
    const [vehicleContext, searchShopIds] = await Promise.all([
      resolveVehicleContext(db, { year, make, model, engine, roId, mosShopId, provider }),
      resolveSearchShopIds(db, mosShopId, isPlatformAdmin, userShopIds),
    ]);
    year = vehicleContext.year;
    make = vehicleContext.make;
    model = vehicleContext.model;
    engine = vehicleContext.engine;
    
    console.log(`[Jobs Search] Query: "${query}", Y/M/M/E: ${year}/${make}/${model}/${engine}, shopIds: ${searchShopIds.join(',')}`);

    const jobsCollection = db.collection("job_index");

    const { coreTokens, allTokens } = buildSearchQuery(query);
    
    const matchStage: Record<string, any> = {};
    
    const shopIdVariants = searchShopIds.flatMap(id => [Number(id), String(id)]);
    if (searchShopIds.length === 1) {
      matchStage.shopId = { $in: [Number(searchShopIds[0]), String(searchShopIds[0])] };
    } else if (searchShopIds.length > 1) {
      matchStage.shopId = { $in: shopIdVariants };
    }
    
    if (coreTokens.length > 0) {
      matchStage["job.keywords"] = { $all: coreTokens };
    } else if (allTokens.length > 0) {
      matchStage["job.keywords"] = { $in: allTokens };
    } else {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      matchStage["job.title"] = { $regex: escaped, $options: "i" };
    }
    
    if (make) {
      matchStage["vehicle.make"] = { $regex: escapeRegex(make), $options: "i" };
    }
    // NOTE: Model is NOT used as a hard filter - it's used for scoring only.
    // This matches the dashboard behavior and allows "oil change on HHR" to find
    // results from other Chevrolet models (Trax, Cruze, etc.) when no exact
    // HHR-specific jobs exist in the shop's history.

    const [jobIndexResults, normalizedResults] = await Promise.all([
      jobsCollection
        .aggregate([
          { $match: matchStage },
          { $sort: { performedAt: -1 } },
          { $limit: limit * 5 }
        ], { maxTimeMS: 8000 })
        .toArray(),
      searchNormalizedCollections(db, searchShopIds, coreTokens, make || undefined, limit * 2, model || undefined)
    ]);

    const seenKeys = new Set<string>();
    let jobs: any[] = [];
    
    for (const job of jobIndexResults) {
      const key = `${job.workOrderId || ''}-${job.job?.title || ''}-legacy`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        jobs.push({ ...job, dataSource: 'job_index' });
      }
    }
    
    for (const job of normalizedResults) {
      const key = `${job.workOrderId || ''}-${job.job?.title || ''}-${job.sourceSystem}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        jobs.push({ ...job, dataSource: 'normalized' });
      }
    }

    console.log(`[Jobs Search] Found ${jobIndexResults.length} from job_index, ${normalizedResults.length} from normalized`);

    if (jobs.length === 0 && coreTokens.length > 0) {
      const fallbackMatch: Record<string, any> = {};
      if (searchShopIds.length === 1) {
        fallbackMatch.shopId = { $in: [Number(searchShopIds[0]), String(searchShopIds[0])] };
      } else if (searchShopIds.length > 1) {
        fallbackMatch.shopId = { $in: shopIdVariants };
      }
      fallbackMatch["job.title"] = { $regex: coreTokens.map(escapeRegex).join(".*"), $options: "i" };
      if (make) fallbackMatch["vehicle.make"] = { $regex: escapeRegex(make), $options: "i" };
      jobs = await jobsCollection
        .aggregate([
          { $match: fallbackMatch },
          { $sort: { performedAt: -1 } },
          { $limit: limit * 3 }
        ], { maxTimeMS: 5000 })
        .toArray();
      if (jobs.length > 0) {
        console.log(`[Jobs Search] Fallback title search found ${jobs.length} candidates`);
      }
    }

    console.log(`[Jobs Search] Found ${jobs.length} total candidates for scoring`);

    // Score using shared scoring logic
    const targetVehicle = { year, make, model, engine };
    const scoredJobs: ScoredJob[] = jobs.map(job => scoreJob(job, targetVehicle));
    
    // Log scoring results for debugging
    if (scoredJobs.length > 0) {
      console.log(`[Jobs Search] Scoring results:`, scoredJobs.slice(0, 5).map(j => ({
        title: j.job?.title || j.title,
        score: j.matchScore,
        gatePass: j.gatePass,
        reason: j.matchReason,
        vehicle: j.vehicle
      })));
    }
    
    // Filter by gate pass only - lower threshold to 20 for extension searches
    // We want to show more potential matches even if they're not perfect
    const eligibleJobs = scoredJobs.filter(j => j.gatePass && j.matchScore >= 20);
    
    // Sort by score
    eligibleJobs.sort((a, b) => b.matchScore - a.matchScore);
    
    // Deduplicate by job title + vehicle
    const uniqueJobs = new Map<string, ScoredJob>();
    for (const job of eligibleJobs) {
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
        source: sourceType,
        shopId: job.shopId || null,
        location: shopLocationMap.get(job.shopId) || null,
      };
    });

    return NextResponse.json({ 
      jobs: formattedJobs,
      total: formattedJobs.length,
      query,
      stats: {
        totalFound: jobs.length,
        fromJobIndex: jobIndexResults.length,
        fromNormalized: normalizedResults.length,
        gatesFailed: scoredJobs.filter(j => !j.gatePass).length,
        belowThreshold: scoredJobs.filter(j => j.gatePass && j.matchScore < 40).length,
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
