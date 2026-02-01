import { NextRequest, NextResponse } from "next/server";
import sql from "@/lib/db/postgres";
import { validateExtensionToken, getUserShopIds } from "@/lib/extension-auth";
import { scoreJob, buildSearchQuery, ScoredJob } from "@/lib/job-scoring";
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
    const roId = searchParams.get("roId");
    let year = searchParams.get("year");
    let make = searchParams.get("make");
    let model = searchParams.get("model");
    let engine = searchParams.get("engine");
    const limit = Math.min(parseInt(searchParams.get("limit") || "20"), 50);

    const auth = await validateExtensionToken(request);
    if (!auth.authorized || !auth.user) {
      return NextResponse.json({ error: auth.error || "Unauthorized" }, { status: 401, headers: corsHeaders });
    }

    const userShopIds = getUserShopIds(auth.user).map(id => parseInt(String(id)));
    const isPlatformAdmin = auth.user.role === "platform_admin";

    let mosShopId: number | null = auth.user.shopId ? parseInt(String(auth.user.shopId)) : null;
    let provider: string = 'tekmetric';
    
    if (mosShopId) {
      const shopRows = await sql`
        SELECT settings FROM shops WHERE shop_id = ${String(mosShopId)} LIMIT 1
      `;
      const shopDoc = shopRows[0];
      if (shopDoc) {
        const settings = shopDoc.settings || {};
        provider = settings.integrationProvider 
          || (settings.tekmetric?.shopId ? 'tekmetric' 
            : settings.protractor?.connectionId ? 'protractor' 
            : settings.autoflow?.domain ? 'autoflow' 
            : 'tekmetric');
      }
    } else if (smsShopId) {
      const shopResult = await findShopBySmsId(smsShopId, { userShopIds, isPlatformAdmin });
      if (shopResult) {
        mosShopId = shopResult.mosShopId;
        provider = shopResult.provider;
      }
    }

    if (!query.trim()) {
      return NextResponse.json({ jobs: [] }, { headers: corsHeaders });
    }
    
    if (!year && !make && !model && roId && mosShopId) {
      const workOrderRows = await sql`
        SELECT vehicle_year, vehicle_make, vehicle_model, vehicle_engine FROM tekmetric_work_orders
        WHERE shop_id = ${String(mosShopId)} AND work_order_id = ${roId}
        LIMIT 1
      `;
      const workOrder = workOrderRows[0];
      
      if (workOrder) {
        year = workOrder.vehicle_year?.toString() || null;
        make = workOrder.vehicle_make || null;
        model = workOrder.vehicle_model || null;
        engine = workOrder.vehicle_engine || null;
        console.log(`[Jobs Search] Resolved vehicle from WO ${roId}: ${year} ${make} ${model}`);
      } else if (provider === "tekmetric") {
        console.log(`[Jobs Search] WO ${roId} not in cache, fetching from Tekmetric API`);
        try {
          const tekApiToken = await getValidToken();
          const res = await fetch(`https://shop.tekmetric.com/api/v1/repair-orders/${roId}`, {
            headers: { Authorization: `Bearer ${tekApiToken}` }
          });
          if (res.ok) {
            const data = await res.json();
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
    
    let searchShopIds: number[] = [];
    if (mosShopId) {
      const enterprise = await getEnterpriseByShopId(mosShopId);
      if (enterprise && enterprise.shopIds.length > 1) {
        const shopRows = await sql`
          SELECT settings FROM shops WHERE shop_id = ${String(mosShopId)} LIMIT 1
        `;
        const shop = shopRows[0];
        const jobHistoryShopIds = shop?.settings?.preferences?.jobHistoryShopIds;
        
        if (Array.isArray(jobHistoryShopIds) && jobHistoryShopIds.length > 0) {
          searchShopIds = jobHistoryShopIds.filter((id: number) => enterprise.shopIds.includes(id));
          if (!searchShopIds.includes(mosShopId)) {
            searchShopIds.push(mosShopId);
          }
          console.log(`[Jobs Search] Enterprise search (custom): shops ${searchShopIds.join(', ')}`);
        } else {
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

    const { coreTokens, allTokens } = buildSearchQuery(query);
    
    let jobs: any[] = [];
    
    if (searchShopIds.length > 0) {
      const searchShopIdsStr = searchShopIds.map(String);
      
      if (coreTokens.length > 0) {
        const keywordsPattern = coreTokens.join(' & ');
        const titlePattern = `%${coreTokens.join('%')}%`;
        
        jobs = await sql`
          SELECT * FROM job_index
          WHERE shop_id = ANY(${searchShopIdsStr}::text[])
            AND (
              job->'keywords' @> ${JSON.stringify(coreTokens)}::jsonb
              OR job->>'title' ILIKE ${titlePattern}
            )
            ${make ? sql`AND vehicle->>'make' ILIKE ${`%${make}%`}` : sql``}
            ${model ? sql`AND vehicle->>'model' ILIKE ${`%${model}%`}` : sql``}
          ORDER BY performed_at DESC
          LIMIT ${limit * 5}
        `;
      } else if (allTokens.length > 0) {
        jobs = await sql`
          SELECT * FROM job_index
          WHERE shop_id = ANY(${searchShopIdsStr}::text[])
            AND job->'keywords' ?| ${allTokens}
            ${make ? sql`AND vehicle->>'make' ILIKE ${`%${make}%`}` : sql``}
            ${model ? sql`AND vehicle->>'model' ILIKE ${`%${model}%`}` : sql``}
          ORDER BY performed_at DESC
          LIMIT ${limit * 5}
        `;
      } else {
        const searchPattern = `%${query}%`;
        jobs = await sql`
          SELECT * FROM job_index
          WHERE shop_id = ANY(${searchShopIdsStr}::text[])
            AND (job->>'title' ILIKE ${searchPattern} OR title ILIKE ${searchPattern})
            ${make ? sql`AND vehicle->>'make' ILIKE ${`%${make}%`}` : sql``}
            ${model ? sql`AND vehicle->>'model' ILIKE ${`%${model}%`}` : sql``}
          ORDER BY performed_at DESC
          LIMIT ${limit * 5}
        `;
      }
    }

    console.log(`[Jobs Search] Found ${jobs.length} candidates for scoring`);

    const targetVehicle = { year, make, model, engine };
    const scoredJobs: ScoredJob[] = jobs.map(job => scoreJob(job, targetVehicle));
    
    const eligibleJobs = scoredJobs.filter(j => j.gatePass && j.matchScore >= 40);
    
    eligibleJobs.sort((a, b) => b.matchScore - a.matchScore);
    
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
        _id: job.id?.toString(),
        title: job.job?.title || job.title || "Job",
        description: job.job?.description,
        code: job.job?.code,
        vehicle: job.vehicle,
        workOrderNumber: job.workOrderNumber || job.work_order_number,
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
