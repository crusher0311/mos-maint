import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { validateExtensionToken, getUserShopIds } from "@/lib/extension-auth";
import { scoreJob, buildSearchQuery, STOPWORDS, ScoredJob } from "@/lib/job-scoring";
import { getEnterpriseByShopId } from "@/lib/enterprise";
import { getValidToken } from "@/lib/tekmetric-auth";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";

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
    const roId = searchParams.get("roId"); // RO ID for vehicle lookup fallback
    let year = searchParams.get("year");
    let make = searchParams.get("make");
    let model = searchParams.get("model");
    let engine = searchParams.get("engine");
    const limit = Math.min(parseInt(searchParams.get("limit") || "20"), 50);

    const auth = await validateExtensionToken(request);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json({ error: auth.error || "Unauthorized" }, { status: 401, headers: corsHeaders });
    }

    const db = await getDb();
    const userShopIds = getUserShopIds(auth.user).map(id => parseInt(id));
    const isPlatformAdmin = auth.user.role === "platform_admin";

    // For extension requests, always prefer the SMS shop ID from the URL
    // This ensures we search the shop the user is viewing in Tekmetric/Protractor,
    // not their MOS session shop (which might be different when impersonating)
    let mosShopId: number | null = null;
    let provider: string = 'tekmetric';
    
    if (smsShopId) {
      // Look up shop from SMS shop ID (Tekmetric/Protractor shop ID)
      const shopResult = await findShopBySmsId(smsShopId, { userShopIds, isPlatformAdmin });
      if (shopResult) {
        mosShopId = shopResult.mosShopId;
        provider = shopResult.provider;
        console.log(`[Jobs Search] Resolved shop from SMS ID ${smsShopId} -> MOS shop ${mosShopId}`);
      }
    }
    
    // Fall back to session shop if no SMS shop found
    if (!mosShopId && auth.user.shopId) {
      mosShopId = parseInt(auth.user.shopId);
      // Look up integration provider for session shop
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
    
    // If no vehicle context provided but we have roId, look up the work order to get vehicle info
    if (!year && !make && !model && roId && mosShopId) {
      // Get vehicle info directly from tekmetric_work_orders (stores vehicleYear/vehicleMake/vehicleModel)
      const workOrder = await db.collection("tekmetric_work_orders").findOne({
        shopId: { $in: [String(mosShopId), Number(mosShopId)] },
        workOrderId: String(roId)
      });
      
      if (workOrder) {
        // Work order has vehicle fields at top level (vehicleYear, vehicleMake, etc.)
        year = workOrder.vehicleYear?.toString() || null;
        make = workOrder.vehicleMake || null;
        model = workOrder.vehicleModel || null;
        engine = workOrder.vehicleEngine || null;
        console.log(`[Jobs Search] Resolved vehicle from WO ${roId}: ${year} ${make} ${model}`);
      } else if (provider === "tekmetric") {
        // Work order not in sync cache - fetch directly from Tekmetric API
        console.log(`[Jobs Search] WO ${roId} not in cache, fetching from Tekmetric API`);
        try {
          const tekApiToken = await getValidToken();
          const res = await fetch(`https://shop.tekmetric.com/api/v1/repair-orders/${roId}`, {
            headers: { Authorization: `Bearer ${tekApiToken}` }
          });
          if (res.ok) {
            const data = await res.json();
            // If no VIN but we have vehicleId, fetch vehicle details
            if (data?.vehicleId) {
              const vehRes = await fetch(`https://shop.tekmetric.com/api/v1/vehicles/${data.vehicleId}`, {
                headers: { Authorization: `Bearer ${tekApiToken}` }
              });
              if (vehRes.ok) {
                const vehData = await vehRes.json();
                year = vehData?.year?.toString() || null;
                make = vehData?.make || null;
                model = vehData?.model || null;
                engine = vehData?.engine || null;
                console.log(`[Jobs Search] Resolved vehicle from Tekmetric API: ${year} ${make} ${model}`);
              }
            }
          }
        } catch (e) {
          console.error(`[Jobs Search] Tekmetric API fetch failed:`, e);
        }
      } else {
        console.log(`[Jobs Search] No WO found for roId ${roId} in shop ${mosShopId}`);
      }
    }
    
    // Check if shop is part of an enterprise - if so, search enterprise shops based on preferences
    let searchShopIds: number[] = [];
    if (mosShopId) {
      const enterprise = await getEnterpriseByShopId(mosShopId);
      if (enterprise && enterprise.shopIds.length > 1) {
        // Check shop preferences for job history location selection
        const shop = await db.collection("shops").findOne({ shopId: mosShopId });
        const jobHistoryShopIds = shop?.preferences?.jobHistoryShopIds;
        
        if (Array.isArray(jobHistoryShopIds) && jobHistoryShopIds.length > 0) {
          // Use the shop's selected locations (must be within enterprise)
          searchShopIds = jobHistoryShopIds.filter((id: number) => enterprise.shopIds.includes(id));
          // Always include own shop
          if (!searchShopIds.includes(mosShopId)) {
            searchShopIds.push(mosShopId);
          }
          console.log(`[Jobs Search] Enterprise search (custom): shops ${searchShopIds.join(', ')}`);
        } else {
          // Default: search all enterprise shops
          searchShopIds = enterprise.shopIds;
          console.log(`[Jobs Search] Enterprise search (all): shops ${searchShopIds.join(', ')}`);
        }
      } else {
        searchShopIds = [mosShopId];
      }
    } else if (!isPlatformAdmin) {
      searchShopIds = userShopIds;
    }
    
    console.log(`[Jobs Search] Query: "${query}", Y/M/M/E: ${year}/${make}/${model}/${engine}, shopIds: ${searchShopIds.join(',')}`);

    const jobsCollection = db.collection("job_index");

    // Build search query using same stopword logic as web app
    const { coreTokens, allTokens } = buildSearchQuery(query);
    
    const matchStage: Record<string, any> = {};
    
    // Shop filter - search all enterprise shops if applicable
    if (searchShopIds.length === 1) {
      matchStage.shopId = searchShopIds[0];
    } else if (searchShopIds.length > 1) {
      matchStage.shopId = { $in: searchShopIds };
    }
    
    // Text search using same logic as web app
    if (coreTokens.length > 0) {
      matchStage.$or = [
        { "job.keywords": { $all: coreTokens } },
        { "job.title": { $regex: coreTokens.map(t => `(?=.*${t})`).join(""), $options: "i" } },
      ];
    } else if (allTokens.length > 0) {
      matchStage["job.keywords"] = { $in: allTokens };
    } else {
      // Fallback to regex on title
      const searchRegex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      matchStage.$or = [
        { "job.title": searchRegex },
        { "title": searchRegex },
      ];
    }
    
    // Optional make/model filtering for pre-filtering (same as web app)
    if (make) {
      matchStage["vehicle.make"] = { $regex: new RegExp(make, "i") };
    }
    if (model) {
      matchStage["vehicle.model"] = { $regex: new RegExp(model, "i") };
    }

    // Fetch candidates
    const jobs: any[] = await jobsCollection
      .aggregate([
        { $match: matchStage },
        { $sort: { performedAt: -1 } },
        { $limit: limit * 5 }
      ])
      .toArray();

    console.log(`[Jobs Search] Found ${jobs.length} candidates for scoring`);

    // Score using shared scoring logic
    const targetVehicle = { year, make, model, engine };
    const scoredJobs: ScoredJob[] = jobs.map(job => scoreJob(job, targetVehicle));
    
    // Filter by gate pass and minimum score threshold
    const eligibleJobs = scoredJobs.filter(j => j.gatePass && j.matchScore >= 40);
    
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
      
      const partsAmount = rawTotals.partsAmount || calculatedPartsAmount;
      const laborAmount = rawTotals.laborAmount || calculatedLaborAmount;
      const totalAmount = rawTotals.totalAmount || (partsAmount + laborAmount);
      
      return {
        _id: job._id.toString(),
        title: job.job?.title || job.title || "Job",
        description: job.job?.description,
        code: job.job?.code,
        vehicle: job.vehicle,
        workOrderNumber: job.workOrderNumber,
        laborItems: laborLines.map((l: any) => ({
          name: l.description,
          hours: parseFloat(l.hours) || parseFloat(l.quantity) || 0
        })),
        parts: partLines.map((l: any) => ({
          name: l.description,
          partNumber: l.partNumber,
          brand: l.manufacturer,
          quantity: l.quantity || 1,
          cost: l.cost || 0,
          retail: l.unitPrice || l.extendedPrice || 0
        })),
        totals: {
          laborHours: rawTotals.laborHours || laborHours || 0,
          laborAmount,
          partsAmount,
          totalAmount,
        },
        matchScore: job.matchScore,
        matchBand: job.matchBand,
        matchBandLabel: job.matchBandLabel,
        matchReason: job.matchReason,
        source: sourceType
      };
    });

    return NextResponse.json({ 
      jobs: formattedJobs,
      total: formattedJobs.length,
      query,
      stats: {
        totalFound: jobs.length,
        gatesFailed: scoredJobs.filter(j => !j.gatePass).length,
        belowThreshold: scoredJobs.filter(j => j.gatePass && j.matchScore < 40).length,
        returned: formattedJobs.length,
      }
    }, { headers: corsHeaders });

  } catch (error: any) {
    console.error("[Extension Jobs Search] Error:", error);
    return NextResponse.json(
      { error: "Search failed" },
      { status: 500, headers: corsHeaders }
    );
  }
}
