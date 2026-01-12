import { NextRequest, NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { NORMALIZED_COLLECTIONS } from "@/lib/normalized-schema";
import { getNormalizedCache, CACHE_KEYS, CACHE_TTL } from "@/lib/normalized-cache";

export const dynamic = "force-dynamic";

const BATCH_SIZE = 200;

interface SearchResult {
  _id: string;
  workOrderId: string;
  workOrderNumber: string;
  title: string;
  description?: string;
  hours?: number;
  total?: number;
  laborTotal?: number;
  partsTotal?: number;
  vin?: string;
  year?: number;
  make?: string;
  model?: string;
  engine?: string;
  closedDate?: Date;
  sourceSystem: string;
  shopId: number;
  score: number;
}

interface PaginatedResponse {
  results: SearchResult[];
  pagination: {
    limit: number;
    total?: number;
    hasMore: boolean;
    nextCursor?: string;
  };
  source: string;
  cached?: boolean;
  meta?: {
    queryTimeMs: number;
  };
}

interface LocationPriorityPrefs {
  enabled: boolean;
  priorityShopIds: number[];
  excludeOthers: boolean;
}

function scoreJob(
  job: any, 
  query: string, 
  shopId: number,
  locationPriority?: LocationPriorityPrefs
): number {
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);
  
  let score = 0;
  const title = (job.title || '').toLowerCase();
  const description = (job.description || '').toLowerCase();
  
  if (title === queryLower) {
    score += 100;
  } else if (title.includes(queryLower)) {
    score += 50;
  }
  
  for (const word of queryWords) {
    if (title.includes(word)) score += 10;
    if (description.includes(word)) score += 5;
  }
  
  if (locationPriority?.enabled && locationPriority.priorityShopIds.length > 0) {
    const priorityIndex = locationPriority.priorityShopIds.indexOf(Number(job.shopId));
    if (priorityIndex !== -1) {
      const priorityBonus = Math.max(5, 20 - (priorityIndex * 5));
      score += priorityBonus;
    } else if (!locationPriority.excludeOthers && job.shopId === shopId) {
      score += 10;
    }
  } else {
    if (job.shopId === shopId) {
      score += 20;
    }
  }
  
  if (job.closedDate) {
    const daysSinceClosed = (Date.now() - new Date(job.closedDate).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceClosed < 30) score += 10;
    else if (daysSinceClosed < 90) score += 5;
    else if (daysSinceClosed < 365) score += 2;
  }
  
  if (job.hours && job.hours > 0) score += 5;
  if (job.total && job.total > 0) score += 5;
  
  return score;
}

function buildPipeline(
  enterpriseShopIds: number[],
  query: string,
  vin: string,
  year: string,
  make: string,
  model: string,
  cursor?: string,
  batchSize: number = BATCH_SIZE
): any[] {
  const pipeline: any[] = [];

  const matchStage: any = {
    shopId: { $in: enterpriseShopIds },
    'softDelete.isDeleted': { $ne: true },
  };

  if (cursor) {
    try {
      matchStage._id = { $gt: new ObjectId(cursor) };
    } catch {}
  }

  pipeline.push({ $match: matchStage });

  if (query) {
    const queryWords = query.split(/\s+/).filter(w => w.length > 2);
    if (queryWords.length > 0) {
      pipeline.push({
        $match: {
          $and: queryWords.map(word => ({
            $or: [
              { title: { $regex: word, $options: 'i' } },
              { description: { $regex: word, $options: 'i' } },
            ]
          }))
        }
      });
    }
  }

  pipeline.push(
    {
      $lookup: {
        from: NORMALIZED_COLLECTIONS.workOrders,
        let: { workOrderId: '$workOrderId' },
        pipeline: [
          { $match: { $expr: { $eq: [{ $toString: '$_id' }, '$$workOrderId'] } } },
          { $limit: 1 }
        ],
        as: 'workOrder'
      }
    },
    { $unwind: { path: '$workOrder', preserveNullAndEmptyArrays: true } }
  );

  if (vin || year || make || model) {
    const vehicleMatch: any = {};
    if (vin) vehicleMatch.vin = vin;
    if (year) vehicleMatch.year = parseInt(year);
    if (make) vehicleMatch.make = { $regex: make, $options: 'i' };
    if (model) vehicleMatch.model = { $regex: model, $options: 'i' };

    pipeline.push(
      {
        $lookup: {
          from: NORMALIZED_COLLECTIONS.vehicles,
          let: { vehicleId: '$workOrder.vehicleId' },
          pipeline: [
            { $match: { $expr: { $eq: [{ $toString: '$_id' }, '$$vehicleId'] } } },
            { $match: vehicleMatch },
            { $limit: 1 }
          ],
          as: 'vehicle'
        }
      },
      { $match: { vehicle: { $ne: [] } } },
      { $unwind: { path: '$vehicle', preserveNullAndEmptyArrays: true } }
    );
  } else {
    pipeline.push(
      {
        $lookup: {
          from: NORMALIZED_COLLECTIONS.vehicles,
          let: { vehicleId: '$workOrder.vehicleId' },
          pipeline: [
            { $match: { $expr: { $eq: [{ $toString: '$_id' }, '$$vehicleId'] } } },
            { $limit: 1 }
          ],
          as: 'vehicle'
        }
      },
      { $unwind: { path: '$vehicle', preserveNullAndEmptyArrays: true } }
    );
  }

  pipeline.push(
    { $sort: { _id: 1 } },
    { $limit: batchSize + 1 },
    {
      $project: {
        _id: 1,
        workOrderId: 1,
        workOrderNumber: '$workOrder.workOrderNumber',
        title: 1,
        description: 1,
        hours: { $ifNull: ['$laborHoursBilled', '$laborHoursActual'] },
        total: 1,
        laborTotal: 1,
        partsTotal: 1,
        vin: '$vehicle.vin',
        year: '$vehicle.year',
        make: '$vehicle.make',
        model: '$vehicle.model',
        engine: '$vehicle.engineDescription',
        closedDate: '$workOrder.closedDate',
        sourceSystem: { $ifNull: ['$provenance.sourceSystem', 'unknown'] },
        shopId: 1,
      }
    }
  );

  return pipeline;
}

export async function GET(req: NextRequest) {
  const startTime = Date.now();
  
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
  const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") || "50")), 100);
  const cursor = url.searchParams.get("cursor") || undefined;

  if (!query && !vin) {
    return NextResponse.json({ error: "Missing query or VIN" }, { status: 400 });
  }

  const db = await getDb();
  const cache = getNormalizedCache();
  
  const user = await db.collection("users").findOne(
    { email: session.email },
    { projection: { preferences: 1 } }
  );
  const locationPriority: LocationPriorityPrefs | undefined = user?.preferences?.jobHistory;
  
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

  const batchCacheKey = { shopId, query, vin, year, make, model, includeEnterprise, cursor: cursor || 'start' };
  const cached = cache.get<{ results: SearchResult[]; hasMore: boolean; nextCursor?: string }>(
    CACHE_KEYS.SEARCH_RESULTS, 
    batchCacheKey
  );
  
  if (cached) {
    const paginatedResults = cached.results.slice(0, limit);
    return NextResponse.json({
      results: paginatedResults,
      pagination: {
        limit,
        hasMore: cached.hasMore || cached.results.length > limit,
        nextCursor: cached.results.length > limit 
          ? cached.results[limit - 1]._id 
          : cached.nextCursor,
      },
      source: 'normalized',
      cached: true,
      meta: { queryTimeMs: Date.now() - startTime },
    } as PaginatedResponse);
  }

  const serviceJobsCollection = db.collection(NORMALIZED_COLLECTIONS.serviceJobs);
  const pipeline = buildPipeline(enterpriseShopIds, query, vin, year, make, model, cursor, BATCH_SIZE);
  
  const rawResults = await serviceJobsCollection.aggregate(pipeline).toArray();
  
  const hasMore = rawResults.length > BATCH_SIZE;
  const resultsToProcess = hasMore ? rawResults.slice(0, BATCH_SIZE) : rawResults;
  
  let filteredResults = resultsToProcess;
  const shouldFilter = locationPriority?.enabled && 
                       locationPriority.excludeOthers && 
                       locationPriority.priorityShopIds.length > 0;
  if (shouldFilter) {
    filteredResults = resultsToProcess.filter((job: any) => 
      locationPriority!.priorityShopIds.includes(Number(job.shopId))
    );
  }

  const scoredResults: SearchResult[] = filteredResults.map((job: any) => ({
    _id: String(job._id),
    workOrderId: String(job.workOrderId),
    workOrderNumber: job.workOrderNumber || '',
    title: job.title,
    description: job.description,
    hours: job.hours,
    total: job.total,
    laborTotal: job.laborTotal,
    partsTotal: job.partsTotal,
    vin: job.vin,
    year: job.year,
    make: job.make,
    model: job.model,
    engine: job.engine,
    closedDate: job.closedDate,
    sourceSystem: job.sourceSystem,
    shopId: job.shopId,
    score: scoreJob(job, query, shopId, locationPriority),
  }));

  scoredResults.sort((a, b) => b.score - a.score);

  const nextCursor = hasMore ? resultsToProcess[resultsToProcess.length - 1]._id : undefined;
  
  cache.set(
    CACHE_KEYS.SEARCH_RESULTS, 
    batchCacheKey, 
    { results: scoredResults, hasMore, nextCursor },
    CACHE_TTL.MEDIUM
  );

  const paginatedResults = scoredResults.slice(0, limit);
  
  return NextResponse.json({
    results: paginatedResults,
    pagination: {
      limit,
      hasMore: hasMore || scoredResults.length > limit,
      nextCursor: scoredResults.length > limit 
        ? scoredResults[limit - 1]._id 
        : nextCursor,
    },
    source: 'normalized',
    cached: false,
    meta: { queryTimeMs: Date.now() - startTime },
  } as PaginatedResponse);
}
