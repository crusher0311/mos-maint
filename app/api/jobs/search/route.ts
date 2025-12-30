// app/api/jobs/search/route.ts
// Job Lookup / Parts Intelligence - Search API

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/app/lib/mongo";

export const dynamic = "force-dynamic";

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
    let score = 50;
    
    if (vehicleYear && job.vehicle.year) {
      const yearDiff = Math.abs(parseInt(vehicleYear) - job.vehicle.year);
      if (yearDiff === 0) score += 30;
      else if (yearDiff <= 2) score += 20;
      else if (yearDiff <= 5) score += 10;
    }
    
    if (vehicleMake && job.vehicle.make) {
      if (job.vehicle.make.toLowerCase() === vehicleMake.toLowerCase()) {
        score += 15;
      }
    }
    
    if (vehicleModel && job.vehicle.model) {
      if (job.vehicle.model.toLowerCase() === vehicleModel.toLowerCase()) {
        score += 20;
      }
    }
    
    if (vehicleEngine && job.vehicle.engine) {
      if (job.vehicle.engine.toLowerCase().includes(vehicleEngine.toLowerCase())) {
        score += 15;
      }
    }
    
    if (job.lines?.length > 0) {
      score += 5;
    }
    
    const daysSincePerformed = (Date.now() - new Date(job.performedAt).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSincePerformed < 90) score += 5;
    else if (daysSincePerformed < 365) score += 2;
    
    return {
      ...job,
      matchScore: Math.min(score, 100),
      matchReason: buildMatchReason(job, vehicleYear, vehicleMake, vehicleModel, vehicleEngine),
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

function buildMatchReason(
  job: any, 
  targetYear?: string | null, 
  targetMake?: string | null, 
  targetModel?: string | null, 
  targetEngine?: string | null
): string {
  const reasons: string[] = [];
  
  if (targetYear && job.vehicle.year) {
    const diff = Math.abs(parseInt(targetYear) - job.vehicle.year);
    if (diff === 0) reasons.push("Exact year match");
    else if (diff <= 2) reasons.push(`${diff} year${diff > 1 ? 's' : ''} difference`);
  }
  
  if (targetMake && job.vehicle.make?.toLowerCase() === targetMake.toLowerCase()) {
    reasons.push("Same make");
  }
  
  if (targetModel && job.vehicle.model?.toLowerCase() === targetModel.toLowerCase()) {
    reasons.push("Same model");
  }
  
  if (targetEngine && job.vehicle.engine?.toLowerCase().includes(targetEngine.toLowerCase())) {
    reasons.push("Similar engine");
  }
  
  if (job.lines?.some((l: any) => l.lineType === "part" && l.partNumber)) {
    reasons.push("Has part numbers");
  }
  
  return reasons.join(" | ") || "Keyword match";
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
