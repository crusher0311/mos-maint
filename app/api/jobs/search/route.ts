// app/api/jobs/search/route.ts
// Job Lookup / Parts Intelligence - Search API
// Uses two-stage matching: Hard gates + Weighted scoring

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

function getScoreBand(score: number): ScoreBand {
  if (score >= 85) return "exact";
  if (score >= 70) return "likely";
  if (score >= 50) return "possible";
  return "poor";
}

function getBandLabel(band: ScoreBand): string {
  switch (band) {
    case "exact": return "Exact Fit";
    case "likely": return "Likely Fit";
    case "possible": return "Possible Match";
    case "poor": return "Low Match";
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
  const limit = Math.min(parseInt(searchParams.get("limit") || "20"), 50);

  if (!query && !vehicleMake) {
    return NextResponse.json({ 
      error: "Please provide a search query (q) or vehicle make" 
    }, { status: 400 });
  }

  const db = await getDb();
  
  // Check if shop is part of an enterprise - if so, search all enterprise shops
  let searchShopIds: number[] = [shopId];
  const enterprise = await getEnterpriseByShopId(shopId);
  if (enterprise && enterprise.shopIds.length > 1) {
    searchShopIds = enterprise.shopIds;
    console.log(`[Jobs Search] Enterprise search: shops ${searchShopIds.join(', ')}`);
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
  
  if (query) {
    const allTokens = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    // Core tokens: remove stopwords to get the essential service identifiers
    const coreTokens = allTokens.filter(w => !stopwords.has(w));
    
    // If we have core tokens, require ALL of them to match in keywords or title
    // If all tokens were stopwords, use original tokens but match ANY
    if (coreTokens.length > 0) {
      // Require ALL core tokens to appear in keywords or title
      matchStage.$or = [
        { "job.keywords": { $all: coreTokens } },
        { "job.title": { $regex: coreTokens.map(t => `(?=.*${t})`).join(""), $options: "i" } },
      ];
    } else if (allTokens.length > 0) {
      // Fallback: if only stopwords, match any token in keywords
      matchStage["job.keywords"] = { $in: allTokens };
    }
  }
  
  if (vehicleMake) {
    matchStage["vehicle.make"] = { $regex: new RegExp(vehicleMake, "i") };
  }
  
  if (vehicleModel) {
    matchStage["vehicle.model"] = { $regex: new RegExp(vehicleModel, "i") };
  }

  const pipeline: any[] = [
    { $match: matchStage },
    { $sort: { performedAt: -1 } },
    { $limit: limit * 5 },
  ];

  const jobs = await db.collection("job_index").aggregate(pipeline).toArray();
  
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
    
    const daysSincePerformed = (Date.now() - new Date(job.performedAt).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSincePerformed < 90) {
      evidenceScore += 4;
      matchDetails.push("Recent job");
    } else if (daysSincePerformed < 365) {
      evidenceScore += 2;
    }
    
    // Location bonus: prefer jobs from current shop
    const jobShopId = Number(job.shopId);
    const isCurrentLocation = jobShopId === shopId;
    const locationBonus = isCurrentLocation ? 5 : 0;
    
    // Get location info for display
    const shopInfo = shopLookup.get(jobShopId);
    const locationName = shopInfo?.locationIdentifier || shopInfo?.name || `Shop ${jobShopId}`;
    
    const totalScore = powertrainScore + makeModelScore + yearScore + constraintScore + evidenceScore + locationBonus;
    const normalizedScore = Math.max(0, Math.min(100, totalScore));
    const band = getScoreBand(normalizedScore);
    
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
        locationBonus,
      },
    };
  });
  
  // Lower threshold to 40 to include more results - let user decide relevance
  const eligibleJobs = scoredJobs.filter(j => j.gatePass && j.matchScore >= 40);
  
  eligibleJobs.sort((a, b) => b.matchScore - a.matchScore);

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
