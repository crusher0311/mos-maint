// app/api/jobs/search/route.ts
// Job Lookup / Parts Intelligence - Search API

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const dynamic = "force-dynamic";

function parseEngineString(engine: string): { cylinders: number | null; displacement: number | null } {
  if (!engine) return { cylinders: null, displacement: null };
  
  const normalized = engine.toUpperCase();
  
  let cylinders: number | null = null;
  const v8Match = normalized.match(/V\s*8|8\s*CYL/);
  const v6Match = normalized.match(/V\s*6|6\s*CYL/);
  const i4Match = normalized.match(/I\s*4|4\s*CYL|L\s*4/);
  const v4Match = normalized.match(/V\s*4/);
  
  if (v8Match) cylinders = 8;
  else if (v6Match) cylinders = 6;
  else if (i4Match || v4Match) cylinders = 4;
  
  let displacement: number | null = null;
  const literMatch = normalized.match(/(\d+\.?\d*)\s*L/);
  if (literMatch) {
    displacement = parseFloat(literMatch[1]);
  }
  
  return { cylinders, displacement };
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);
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
  
  const matchStage: any = { shopId };
  
  if (query) {
    const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    if (keywords.length > 0) {
      matchStage["job.keywords"] = { $all: keywords };
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
    { $limit: limit * 3 },
  ];

  const jobs = await db.collection("job_index").aggregate(pipeline).toArray();

  const scoredJobs = jobs.map((job: any) => {
    let score = 0;
    const matchDetails: string[] = [];
    
    const targetYear = vehicleYear ? parseInt(vehicleYear) : null;
    const jobYear = job.vehicle?.year;
    
    if (targetYear && jobYear) {
      const yearDiff = Math.abs(targetYear - jobYear);
      if (yearDiff === 0) {
        score += 25;
        matchDetails.push("Exact year match");
      } else if (yearDiff === 1) {
        score += 20;
        matchDetails.push("1 year difference");
      } else if (yearDiff === 2) {
        score += 15;
        matchDetails.push("2 years difference");
      } else if (yearDiff <= 4) {
        score += 8;
        matchDetails.push(`${yearDiff} years difference`);
      } else {
        score += 2;
        matchDetails.push(`${yearDiff} years difference`);
      }
    }
    
    if (vehicleMake && job.vehicle?.make) {
      if (job.vehicle.make.toLowerCase() === vehicleMake.toLowerCase()) {
        score += 20;
        matchDetails.push("Same make");
      }
    }
    
    if (vehicleModel && job.vehicle?.model) {
      if (job.vehicle.model.toLowerCase() === vehicleModel.toLowerCase()) {
        score += 20;
        matchDetails.push("Same model");
      }
    }
    
    const targetEngineInfo = parseEngineString(vehicleEngine || "");
    const jobEngineInfo = parseEngineString(job.vehicle?.engine || "");
    
    if (targetEngineInfo.cylinders || jobEngineInfo.cylinders) {
      const cylinderMatch = targetEngineInfo.cylinders === jobEngineInfo.cylinders;
      const displacementMatch = targetEngineInfo.displacement && jobEngineInfo.displacement &&
        Math.abs(targetEngineInfo.displacement - jobEngineInfo.displacement) < 0.3;
      
      if (cylinderMatch && displacementMatch) {
        score += 25;
        matchDetails.push("Same engine");
      } else if (cylinderMatch) {
        score += 15;
        matchDetails.push("Same cylinder count");
      } else if (displacementMatch) {
        score += 10;
        matchDetails.push("Similar displacement");
      } else if (targetEngineInfo.cylinders && jobEngineInfo.cylinders) {
        score -= 10;
        matchDetails.push("Different engine");
      }
    }
    
    if (job.lines?.some((l: any) => l.lineType === "part" && l.partNumber)) {
      score += 5;
      matchDetails.push("Has part numbers");
    }
    
    const daysSincePerformed = (Date.now() - new Date(job.performedAt).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSincePerformed < 90) score += 5;
    else if (daysSincePerformed < 365) score += 2;
    
    const normalizedScore = Math.max(0, Math.min(100, score));
    
    return {
      ...job,
      matchScore: normalizedScore,
      matchReason: matchDetails.join(" | ") || "Keyword match",
    };
  });

  scoredJobs.sort((a, b) => b.matchScore - a.matchScore);

  const uniqueJobs = new Map<string, typeof scoredJobs[0]>();
  for (const job of scoredJobs) {
    const key = `${job.job?.title || ''}-${job.vehicle?.make || ''}-${job.vehicle?.model || ''}`;
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
    results,
    totalFound: jobs.length,
    returned: results.length,
  });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);
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
