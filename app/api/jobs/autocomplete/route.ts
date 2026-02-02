import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { NORMALIZED_COLLECTIONS } from "@/lib/normalized-schema";
import { getNormalizedCache, CACHE_KEYS, CACHE_TTL } from "@/lib/normalized-cache";

export const dynamic = "force-dynamic";

const MAX_SUGGESTIONS = 10;
const MIN_QUERY_LENGTH = 2;

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface AutocompleteSuggestion {
  title: string;
  description?: string;
  avgHours?: number;
  avgTotal?: number;
  avgLaborTotal?: number;
  avgPartsTotal?: number;
  occurrences: number;
  lastPerformed?: Date;
  vehicleMatch: boolean;
  cannedJobCode?: string;
}

interface AggregatedJob {
  _id: string;
  title: string;
  description?: string;
  avgHours: number;
  avgTotal: number;
  avgLaborTotal: number;
  avgPartsTotal: number;
  count: number;
  lastPerformed: Date;
  vehicleMatchCount: number;
  cannedJobCode?: string;
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(session.shopId);
  const url = new URL(req.url);
  const query = url.searchParams.get("q") || "";
  const vin = url.searchParams.get("vin") || "";
  const year = url.searchParams.get("year") || "";
  const make = url.searchParams.get("make") || "";
  const model = url.searchParams.get("model") || "";
  const includeEnterprise = url.searchParams.get("enterprise") === "true";

  if (query.length < MIN_QUERY_LENGTH) {
    return NextResponse.json({ suggestions: [] });
  }

  const db = await getDb();
  const cache = getNormalizedCache();
  
  let enterpriseShopIds: number[] = [shopId];
  if (includeEnterprise) {
    const enterpriseCacheKey = { shopId };
    let cachedEnterpriseShops = cache.get<number[]>(CACHE_KEYS.ENTERPRISE_SHOPS, enterpriseCacheKey);
    
    if (!cachedEnterpriseShops) {
      const shop = await db.collection("shops").findOne({ shopId: String(shopId) });
      const enterpriseId = shop?.enterpriseId as string | undefined;
      
      if (enterpriseId) {
        const enterpriseShops = await db.collection("shops")
          .find({ enterpriseId })
          .toArray();
        cachedEnterpriseShops = enterpriseShops.map(s => Number(s.shopId));
        cache.set(CACHE_KEYS.ENTERPRISE_SHOPS, enterpriseCacheKey, cachedEnterpriseShops, CACHE_TTL.LONG);
      } else {
        cachedEnterpriseShops = [shopId];
      }
    }
    enterpriseShopIds = cachedEnterpriseShops;
  }

  const cacheKey = { 
    shopId, 
    query: query.toLowerCase().trim(), 
    vin, 
    year, 
    make, 
    model, 
    includeEnterprise 
  };
  
  const cached = cache.get<AutocompleteSuggestion[]>(CACHE_KEYS.JOB_AUTOCOMPLETE, cacheKey);
  if (cached) {
    return NextResponse.json({ suggestions: cached, cached: true });
  }

  const serviceJobsCollection = db.collection(NORMALIZED_COLLECTIONS.serviceJobs);

  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length >= 2);
  const escapedQueryWords = queryWords.map(escapeRegex);
  
  const pipeline: any[] = [
    {
      $match: {
        shopId: { $in: enterpriseShopIds },
        'softDelete.isDeleted': { $ne: true },
        status: { $in: ['completed', 'authorized'] },
        $and: escapedQueryWords.map(word => ({
          title: { $regex: word, $options: 'i' }
        }))
      }
    },
    {
      $lookup: {
        from: NORMALIZED_COLLECTIONS.workOrders,
        let: { workOrderId: '$workOrderId' },
        pipeline: [
          { $match: { $expr: { $eq: [{ $toString: '$_id' }, '$$workOrderId'] } } },
          { $project: { closedDate: 1, vehicleId: 1 } }
        ],
        as: 'workOrder'
      }
    },
    { $unwind: { path: '$workOrder', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: NORMALIZED_COLLECTIONS.vehicles,
        let: { vehicleId: '$workOrder.vehicleId' },
        pipeline: [
          { $match: { $expr: { $eq: [{ $toString: '$_id' }, '$$vehicleId'] } } },
          { $project: { vin: 1, year: 1, make: 1, model: 1 } }
        ],
        as: 'vehicle'
      }
    },
    { $unwind: { path: '$vehicle', preserveNullAndEmptyArrays: true } },
  ];

  const hasVehicleContext = vin || year || make || model;
  
  if (hasVehicleContext) {
    const matchConditions: any[] = [];
    
    if (vin) {
      matchConditions.push({ $eq: [{ $ifNull: ['$vehicle.vin', ''] }, vin] });
    }
    if (year) {
      const yearNum = parseInt(year);
      matchConditions.push({ $eq: [{ $ifNull: ['$vehicle.year', 0] }, yearNum] });
    }
    if (make) {
      const escapedMake = escapeRegex(make);
      matchConditions.push({
        $regexMatch: { 
          input: { $ifNull: ['$vehicle.make', ''] }, 
          regex: `^${escapedMake}$`, 
          options: 'i' 
        }
      });
    }
    if (model) {
      const escapedModel = escapeRegex(model);
      matchConditions.push({
        $regexMatch: { 
          input: { $ifNull: ['$vehicle.model', ''] }, 
          regex: `^${escapedModel}$`, 
          options: 'i' 
        }
      });
    }

    pipeline.push({
      $addFields: {
        vehicleMatches: {
          $cond: {
            if: {
              $and: [
                { $ne: ['$vehicle', null] },
                ...matchConditions
              ]
            },
            then: 1,
            else: 0
          }
        }
      }
    });
  } else {
    pipeline.push({
      $addFields: { vehicleMatches: 0 }
    });
  }

  pipeline.push(
    {
      $group: {
        _id: { $toLower: { $trim: { input: '$title' } } },
        title: { $first: '$title' },
        description: { $first: '$description' },
        cannedJobCode: { $first: '$cannedJobCode' },
        avgHours: { $avg: { $ifNull: ['$laborHoursBilled', '$laborHoursActual'] } },
        avgTotal: { $avg: '$total' },
        avgLaborTotal: { $avg: '$laborTotal' },
        avgPartsTotal: { $avg: '$partsTotal' },
        count: { $sum: 1 },
        lastPerformed: { $max: '$workOrder.closedDate' },
        vehicleMatchCount: { $sum: '$vehicleMatches' }
      }
    },
    {
      $addFields: {
        relevanceScore: {
          $add: [
            { $multiply: ['$count', 1] },
            { $multiply: ['$vehicleMatchCount', 10] },
            {
              $cond: {
                if: { $gt: ['$lastPerformed', new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)] },
                then: 5,
                else: 0
              }
            }
          ]
        }
      }
    },
    { $sort: { relevanceScore: -1, count: -1 } },
    { $limit: MAX_SUGGESTIONS }
  );

  const aggregatedJobs = await serviceJobsCollection.aggregate(pipeline).toArray() as AggregatedJob[];

  const suggestions: AutocompleteSuggestion[] = aggregatedJobs.map(job => ({
    title: job.title,
    description: job.description,
    avgHours: job.avgHours ? Math.round(job.avgHours * 10) / 10 : undefined,
    avgTotal: job.avgTotal ? Math.round(job.avgTotal * 100) / 100 : undefined,
    avgLaborTotal: job.avgLaborTotal ? Math.round(job.avgLaborTotal * 100) / 100 : undefined,
    avgPartsTotal: job.avgPartsTotal ? Math.round(job.avgPartsTotal * 100) / 100 : undefined,
    occurrences: job.count,
    lastPerformed: job.lastPerformed,
    vehicleMatch: job.vehicleMatchCount > 0,
    cannedJobCode: job.cannedJobCode,
  }));

  cache.set(CACHE_KEYS.JOB_AUTOCOMPLETE, cacheKey, suggestions, CACHE_TTL.SHORT);

  return NextResponse.json({ suggestions, cached: false });
}
