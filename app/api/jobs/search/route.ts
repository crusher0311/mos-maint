// app/api/jobs/search/route.ts
// Job Lookup / Parts Intelligence - Search API
// Uses two-stage matching: Hard gates + Weighted scoring
// Queries both legacy job_index and normalized collections for SMS migration support

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { getEnterpriseByShopId } from "@/lib/enterprise";
import { getFeatureEntitlements } from "@/lib/featureResolver";

export const dynamic = "force-dynamic";

type EngineInfo = {
  cylinders: number | null;
  displacement: number | null;
  aspiration: "na" | "turbo" | "supercharged" | null;
  fuelType: "gas" | "diesel" | "hybrid" | "electric" | null;
};

type ScoreBand = "exact" | "likely" | "possible" | "poor";

function parseEngineString(engine: string): EngineInfo {
  if (!engine) return { cylinders: null, displacement: null, aspiration: null, fuelType: null };
  
  const normalized = engine.toUpperCase();
  
  let cylinders: number | null = null;
  if (/V\s*8|8\s*CYL|8[-\s]?CYLINDER/.test(normalized)) cylinders = 8;
  else if (/V\s*6|6\s*CYL|6[-\s]?CYLINDER/.test(normalized)) cylinders = 6;
  else if (/I\s*4|L\s*4|4\s*CYL|4[-\s]?CYLINDER/.test(normalized)) cylinders = 4;
  else if (/V\s*10|10\s*CYL/.test(normalized)) cylinders = 10;
  else if (/I\s*6|L\s*6/.test(normalized)) cylinders = 6;
  else if (/I\s*3|L\s*3|3\s*CYL/.test(normalized)) cylinders = 3;
  
  let displacement: number | null = null;
  const literMatch = normalized.match(/(\d+\.?\d*)\s*L(?:ITER)?/);
  if (literMatch) {
    displacement = parseFloat(literMatch[1]);
  } else {
    const ccMatch = normalized.match(/(\d{3,4})\s*CC/);
    if (ccMatch) {
      displacement = parseInt(ccMatch[1]) / 1000;
    }
  }
  
  let aspiration: EngineInfo["aspiration"] = "na";
  if (/TURBO|TWIN\s*TURBO|TT|ECOBOOST/.test(normalized)) aspiration = "turbo";
  else if (/SUPERCHARGE|SC|BLOWER/.test(normalized)) aspiration = "supercharged";
  
  let fuelType: EngineInfo["fuelType"] = "gas";
  if (/DIESEL|TDI|DURAMAX|POWERSTROKE|CUMMINS/.test(normalized)) fuelType = "diesel";
  else if (/HYBRID|HEV|PHEV/.test(normalized)) fuelType = "hybrid";
  else if (/ELECTRIC|EV|BATTERY/.test(normalized)) fuelType = "electric";
  
  return { cylinders, displacement, aspiration, fuelType };
}

function getScoreBand(score: number, yearDiff?: number): ScoreBand {
  // "Exact" requires high score AND close year match (within 1 year)
  if (score >= 90 && (yearDiff === undefined || yearDiff <= 1)) return "exact";
  if (score >= 75) return "likely";
  if (score >= 50) return "possible";
  return "poor";
}

function getBandLabel(band: ScoreBand): string {
  switch (band) {
    case "exact": return "Exact Fit";
    case "likely": return "Great Match";
    case "possible": return "Good Match";
    case "poor": return "Low Match";
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function searchNormalizedCollections(
  db: any,
  searchShopIds: number[],
  coreTokens: string[],
  vehicleMake?: string,
  limit: number = 50,
  vehicleModel?: string,
  strictModel: boolean = false,
): Promise<any[]> {
  if (coreTokens.length === 0) return [];

  try {
    const shopMatch = searchShopIds.length === 1 
      ? { shopId: searchShopIds[0] }
      : { shopId: { $in: searchShopIds } };

    // Build regex match conditions - each token must match in at least one of the text fields
    // Using $and to require ALL tokens, with $or to allow matching in any field
    const tokenConditions = coreTokens.map(t => {
      const regex = { $regex: new RegExp(escapeRegex(t), 'i') };
      return {
        $or: [
          { title: regex },
          { description: regex },
          { cannedJobName: regex },
        ]
      };
    });

    const serviceJobsPipeline: any[] = [
      {
        $match: {
          ...shopMatch,
          deletedAt: null,
          $and: tokenConditions
        }
      },
      { $sort: { createdAt: -1 } },
      { $limit: limit * 2 },
      {
        $lookup: {
          from: 'normalized_work_orders',
          localField: 'workOrderId',
          foreignField: '_id',
          as: 'workOrder'
        }
      },
      { $unwind: { path: '$workOrder', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'normalized_vehicles',
          localField: 'workOrder.vehicleId',
          foreignField: '_id',
          as: 'vehicle'
        }
      },
      { $unwind: { path: '$vehicle', preserveNullAndEmptyArrays: true } },
    ];

    if (vehicleMake) {
      serviceJobsPipeline.push({
        $match: { 'vehicle.make': { $regex: new RegExp(escapeRegex(vehicleMake), 'i') } }
      });
    }

    if (strictModel && vehicleModel) {
      serviceJobsPipeline.push({
        $match: { 'vehicle.model': { $regex: new RegExp(`^${escapeRegex(vehicleModel)}$`, 'i') } }
      });
    }

    serviceJobsPipeline.push({ $limit: limit });

    const normalizedJobs = await db.collection('normalized_service_jobs')
      .aggregate(serviceJobsPipeline)
      .toArray();

    return normalizedJobs.map((nj: any) => ({
      _id: nj._id,
      shopId: nj.shopId,
      vin: nj.vehicle?.vin,
      vehicle: {
        vin: nj.vehicle?.vin,
        year: nj.vehicle?.year,
        make: nj.vehicle?.make,
        model: nj.vehicle?.model,
        engine: nj.vehicle?.engine?.description,
      },
      job: {
        title: nj.title,
        description: nj.description,
        name: nj.cannedJobName || nj.title,
        keywords: [],
      },
      lines: (nj.lineItems || []).map((li: any) => ({
        lineType: li.itemType,
        description: li.description,
        partNumber: li.partNumber,
        qty: li.quantity,
        unitPrice: li.unitPrice,
        total: li.totalPrice,
      })),
      performedAt: nj.workOrder?.completedDate || nj.createdAt,
      workOrderId: nj.workOrderId,
      sourceSystem: nj.provenance?.sourceSystem || 'normalized',
    }));
  } catch (err) {
    console.log('[Jobs Search] Normalized search error:', (err as Error).message);
    return [];
  }
}

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
    const shop = await db.collection("shops").findOne({ shopId });
    const jobHistoryShopIds = shop?.preferences?.jobHistoryShopIds;
    
    if (Array.isArray(jobHistoryShopIds) && jobHistoryShopIds.length > 0) {
      // Use the shop's selected locations (must be within enterprise)
      searchShopIds = jobHistoryShopIds.filter((id: number) => enterprise.shopIds.includes(id));
      // Always include own shop
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
    .find({ shopId: { $in: searchShopIds } })
    .project({ shopId: 1, name: 1, locationIdentifier: 1 })
    .toArray();
  
  const shopLookup = new Map<number, { name: string; locationIdentifier: string | null }>();
  for (const s of shopDocs) {
    shopLookup.set(Number(s.shopId), {
      name: s.name || `Shop ${s.shopId}`,
      locationIdentifier: s.locationIdentifier || null,
    });
  }
  
  const matchStage: any = searchShopIds.length === 1 
    ? { shopId: searchShopIds[0] }
    : { shopId: { $in: searchShopIds } };
  
  // Stopwords: common verbs and filler terms that don't identify the service
  const stopwords = new Set([
    "replace", "inspect", "check", "service", "repair", "install", "remove",
    "adjust", "flush", "bleed", "test", "clean", "lube", "lubricate", 
    "change", "perform", "complete", "top", "off", "the", "and", "for"
  ]);
  
  let useTextSearch = false;
  let textSearchQuery = "";
  
  if (query) {
    const allTokens = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    // Core tokens: remove stopwords to get the essential service identifiers
    const coreTokens = allTokens.filter(w => !stopwords.has(w));
    
    if (coreTokens.length > 0) {
      // Use keywords array match (uses compound index shopId_keywords)
      // This is fast with the index and more precise than text search
      matchStage["job.keywords"] = { $all: coreTokens };
      
      // Also enable text search as alternative query strategy
      useTextSearch = true;
      textSearchQuery = coreTokens.join(" ");
    } else if (allTokens.length > 0) {
      // Fallback: if only stopwords, match any token in keywords
      matchStage["job.keywords"] = { $in: allTokens };
    }
  }
  
  if (vehicleMake) {
    matchStage["vehicle.make"] = { $regex: new RegExp(escapeRegex(vehicleMake), "i") };
  }
  
  if (strictModel && vehicleModel) {
    matchStage["vehicle.model"] = { $regex: new RegExp(`^${escapeRegex(vehicleModel)}$`, "i") };
  }
  
  // NOTE: When strictModel is false (default), model is NOT used as a hard filter -
  // it's used for scoring only. This allows "oil change on HHR" to find results
  // from other Chevrolet models (Trax, Cruze, etc.) when no exact HHR jobs exist.
  // When strictModel=true (used by New Work Order history tab), model IS a hard
  // filter so only jobs from the same vehicle model are shown.

  const pipeline: any[] = [
    { $match: matchStage },
    { $sort: { performedAt: -1 } },
    { $limit: limit * 5 },
    { $project: {
      shopId: 1,
      vin: 1,
      vehicle: 1,
      job: 1,
      lines: 1,
      performedAt: 1,
      workOrderId: 1,
    }},
  ];

  // Query both legacy job_index and normalized collections in parallel
  const allTokens = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const coreTokensForNormalized = allTokens.filter(w => !stopwords.has(w));
  
  const [jobIndexResults, normalizedResults] = await Promise.all([
    db.collection("job_index").aggregate(pipeline).toArray(),
    searchNormalizedCollections(db, searchShopIds, coreTokensForNormalized, vehicleMake || undefined, limit * 2, vehicleModel || undefined, strictModel)
  ]);
  
  // Merge results from both sources, deduping by workOrderId + job title
  const seenKeys = new Set<string>();
  const jobs: any[] = [];
  
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
  
  const targetEngine = parseEngineString(vehicleEngine || "");
  const targetYear = vehicleYear ? parseInt(vehicleYear) : null;

  const scoredJobs = jobs.map((job: any) => {
    const jobEngine = parseEngineString(job.vehicle?.engine || "");
    const jobYear = job.vehicle?.year;
    const matchDetails: string[] = [];
    let gatePass = true;
    let gateReason = "";
    
    if (targetEngine.fuelType && jobEngine.fuelType && 
        targetEngine.fuelType !== jobEngine.fuelType) {
      gatePass = false;
      gateReason = `Fuel mismatch (${targetEngine.fuelType} vs ${jobEngine.fuelType})`;
    }
    
    if (gatePass && targetEngine.cylinders && jobEngine.cylinders && 
        targetEngine.cylinders !== jobEngine.cylinders) {
      gatePass = false;
      gateReason = `Cylinder mismatch (${targetEngine.cylinders} vs ${jobEngine.cylinders})`;
    }
    
    if (gatePass && targetEngine.aspiration && jobEngine.aspiration &&
        targetEngine.aspiration !== jobEngine.aspiration) {
      gatePass = false;
      gateReason = `Aspiration mismatch (${targetEngine.aspiration} vs ${jobEngine.aspiration})`;
    }
    
    if (!gatePass) {
      return {
        ...job,
        matchScore: 0,
        matchBand: "poor" as ScoreBand,
        matchBandLabel: "Failed Gate",
        matchReason: gateReason,
        gatePass: false,
      };
    }
    
    let powertrainScore = 0;
    if (targetEngine.cylinders && jobEngine.cylinders) {
      if (targetEngine.cylinders === jobEngine.cylinders) {
        if (targetEngine.displacement && jobEngine.displacement) {
          const dispDiff = Math.abs(targetEngine.displacement - jobEngine.displacement);
          if (dispDiff < 0.1) {
            powertrainScore = 40;
            matchDetails.push("Exact engine match");
          } else if (dispDiff < 0.3) {
            powertrainScore = 36;
            matchDetails.push("Same cylinders, similar displacement");
          } else {
            powertrainScore = 30;
            matchDetails.push("Same cylinders");
          }
        } else {
          powertrainScore = 28;
          matchDetails.push("Same cylinders");
        }
      }
    } else if (!targetEngine.cylinders && !jobEngine.cylinders) {
      powertrainScore = 20;
    }
    
    let makeModelScore = 0;
    const targetMakeLower = vehicleMake?.toLowerCase() || "";
    const targetModelLower = vehicleModel?.toLowerCase() || "";
    const jobMakeLower = job.vehicle?.make?.toLowerCase() || "";
    const jobModelLower = job.vehicle?.model?.toLowerCase() || "";
    
    if (targetMakeLower === jobMakeLower) {
      makeModelScore += 15;
      matchDetails.push("Same make");
    }
    
    if (targetModelLower && jobModelLower) {
      if (targetModelLower === jobModelLower) {
        makeModelScore += 15;
        matchDetails.push("Same model");
      } else if (targetModelLower.includes(jobModelLower) || jobModelLower.includes(targetModelLower)) {
        makeModelScore += 10;
        matchDetails.push("Model family match");
      }
    }
    
    let yearScore = 0;
    if (targetYear && jobYear) {
      const yearDiff = Math.abs(targetYear - jobYear);
      if (yearDiff === 0) {
        yearScore = 10;
        matchDetails.push("Exact year");
      } else if (yearDiff <= 2) {
        yearScore = 8;
        matchDetails.push(`${yearDiff} year${yearDiff > 1 ? 's' : ''} off`);
      } else if (yearDiff <= 4) {
        yearScore = 5;
        matchDetails.push(`${yearDiff} years off`);
      } else {
        yearScore = 2;
        matchDetails.push(`${yearDiff} years off`);
      }
      
      if (powertrainScore >= 36 && yearDiff <= 4) {
        yearScore = Math.min(yearScore + 2, 10);
      }
    }
    
    let constraintScore = 10;
    
    let evidenceScore = 0;
    const hasPartNumbers = job.lines?.some((l: any) => l.lineType === "part" && l.partNumber);
    if (hasPartNumbers) {
      evidenceScore += 6;
      matchDetails.push("Has part numbers");
    }
    
    // Recency scoring - exponential decay with 180-day half-life (max +10 points)
    // Recent jobs likely have more up-to-date pricing
    let recencyScore = 0;
    if (job.performedAt) {
      const daysSincePerformed = (Date.now() - new Date(job.performedAt).getTime()) / (1000 * 60 * 60 * 24);
      // Formula: 10 * 2^(-days/180) gives +10 at day 0, +5 at 180 days, +2.5 at 360 days
      recencyScore = Math.round(10 * Math.pow(2, -(daysSincePerformed / 180)));
      recencyScore = Math.max(0, Math.min(10, recencyScore)); // Clamp to 0-10
      
      if (recencyScore >= 8) {
        matchDetails.push("Very recent job");
      } else if (recencyScore >= 5) {
        matchDetails.push("Recent job");
      }
    }
    
    // Location bonus: prefer jobs from current shop
    const jobShopId = Number(job.shopId);
    const isCurrentLocation = jobShopId === shopId;
    const locationBonus = isCurrentLocation ? 5 : 0;
    
    // Get location info for display
    const shopInfo = shopLookup.get(jobShopId);
    const locationName = shopInfo?.locationIdentifier || shopInfo?.name || `Shop ${jobShopId}`;
    
    const totalScore = powertrainScore + makeModelScore + yearScore + constraintScore + evidenceScore + recencyScore + locationBonus;
    const normalizedScore = Math.max(0, Math.min(100, totalScore));
    
    // Calculate year difference for band determination
    const yearDiffForBand = (targetYear && jobYear) ? Math.abs(targetYear - jobYear) : undefined;
    const band = getScoreBand(normalizedScore, yearDiffForBand);
    
    return {
      ...job,
      matchScore: normalizedScore,
      matchBand: band,
      matchBandLabel: getBandLabel(band),
      matchReason: matchDetails.join(" | ") || "Keyword match",
      gatePass: true,
      isCurrentLocation,
      locationName,
      locationShopId: jobShopId,
      scoreBreakdown: {
        powertrain: powertrainScore,
        makeModel: makeModelScore,
        year: yearScore,
        constraints: constraintScore,
        evidence: evidenceScore,
        recency: recencyScore,
        locationBonus,
      },
    };
  });
  
  // Lower threshold to 40 to include more results - let user decide relevance
  const eligibleJobs = scoredJobs.filter(j => j.gatePass && j.matchScore >= 40);
  
  // Sort by score descending, then by band quality (exact > likely > possible > poor)
  const bandOrder: Record<string, number> = { exact: 0, likely: 1, possible: 2, poor: 3 };
  eligibleJobs.sort((a, b) => {
    if (b.matchScore !== a.matchScore) {
      return b.matchScore - a.matchScore;
    }
    // When scores are equal, prioritize by band (Exact Fit before Great Match)
    return (bandOrder[a.matchBand] ?? 3) - (bandOrder[b.matchBand] ?? 3);
  });

  const uniqueJobs = new Map<string, typeof eligibleJobs[0]>();
  for (const job of eligibleJobs) {
    const key = `${job.job?.title || ''}-${job.vehicle?.make || ''}-${job.vehicle?.model || ''}-${job.vehicle?.year || ''}`;
    const existing = uniqueJobs.get(key);
    if (!existing || existing.matchScore < job.matchScore) {
      uniqueJobs.set(key, job);
    }
  }

  const results = Array.from(uniqueJobs.values()).slice(0, limit);
  
  const gateFailCount = scoredJobs.filter(j => !j.gatePass).length;
  const belowThresholdCount = scoredJobs.filter(j => j.gatePass && j.matchScore < 70).length;

  return NextResponse.json({
    ok: true,
    query,
    vehicle: { year: vehicleYear, make: vehicleMake, model: vehicleModel, engine: vehicleEngine },
    results,
    stats: {
      totalFound: jobs.length,
      fromJobIndex: jobIndexResults.length,
      fromNormalized: normalizedResults.length,
      gatesFailed: gateFailCount,
      belowThreshold: belowThresholdCount,
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
