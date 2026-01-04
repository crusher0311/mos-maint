import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { NORMALIZED_COLLECTIONS } from "@/lib/normalized-schema";

export const dynamic = "force-dynamic";

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

function scoreJob(job: any, query: string, shopId: number): number {
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
  
  if (job.shopId === shopId) {
    score += 20;
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
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 100);

  if (!query && !vin) {
    return NextResponse.json({ error: "Missing query or VIN" }, { status: 400 });
  }

  const db = await getDb();
  
  const shop = await db.collection("shops").findOne({ shopId: String(shopId) });
  const enterpriseId = shop?.enterpriseId ? Number(shop.enterpriseId) : undefined;
  
  let enterpriseShopIds: number[] = [shopId];
  if (includeEnterprise && enterpriseId) {
    const enterpriseShops = await db.collection("shops")
      .find({ enterpriseId: String(enterpriseId) })
      .toArray();
    enterpriseShopIds = enterpriseShops.map(s => Number(s.shopId));
  }

  const serviceJobsCollection = db.collection(NORMALIZED_COLLECTIONS.serviceJobs);
  const workOrdersCollection = db.collection(NORMALIZED_COLLECTIONS.workOrders);
  const vehiclesCollection = db.collection(NORMALIZED_COLLECTIONS.vehicles);

  const vehicleQuery: any = {
    shopId: { $in: enterpriseShopIds },
    'softDelete.isDeleted': { $ne: true },
  };
  
  if (vin) {
    vehicleQuery.vin = vin;
  } else {
    const vehicleFilters: any[] = [];
    if (year) vehicleFilters.push({ year: parseInt(year) });
    if (make) vehicleFilters.push({ make: { $regex: make, $options: 'i' } });
    if (model) vehicleFilters.push({ model: { $regex: model, $options: 'i' } });
    
    if (vehicleFilters.length > 0) {
      vehicleQuery.$and = vehicleFilters;
    }
  }

  const vehicles = await vehiclesCollection.find(vehicleQuery).limit(100).toArray();
  const vehicleIds = vehicles.map(v => String(v._id));
  const vehicleMap = new Map(vehicles.map(v => [String(v._id), v]));

  if (vehicleIds.length === 0 && (vin || year || make || model)) {
    return NextResponse.json({
      results: [],
      total: 0,
      source: 'normalized',
      message: 'No matching vehicles found',
    });
  }

  const workOrderQuery: any = {
    shopId: { $in: enterpriseShopIds },
    'softDelete.isDeleted': { $ne: true },
  };
  
  if (vehicleIds.length > 0) {
    workOrderQuery.vehicleId = { $in: vehicleIds.map(id => String(id)) };
  }

  const workOrders = await workOrdersCollection.find(workOrderQuery).limit(500).toArray();
  const workOrderIds = workOrders.map(wo => String(wo._id));
  const workOrderMap = new Map(workOrders.map(wo => [String(wo._id), wo]));

  if (workOrderIds.length === 0) {
    return NextResponse.json({
      results: [],
      total: 0,
      source: 'normalized',
      message: 'No matching work orders found',
    });
  }

  const serviceJobQuery: any = {
    workOrderId: { $in: workOrderIds.map(id => String(id)) },
    'softDelete.isDeleted': { $ne: true },
  };

  if (query) {
    const queryWords = query.split(/\s+/).filter(w => w.length > 2);
    if (queryWords.length > 0) {
      serviceJobQuery.$and = queryWords.map(word => ({
        $or: [
          { title: { $regex: word, $options: 'i' } },
          { description: { $regex: word, $options: 'i' } },
        ]
      }));
    }
  }

  const serviceJobs = await serviceJobsCollection.find(serviceJobQuery).limit(500).toArray();

  const results: SearchResult[] = serviceJobs.map(job => {
    const workOrder = workOrderMap.get(String(job.workOrderId));
    const vehicle = workOrder ? vehicleMap.get(String(workOrder.vehicleId)) : null;
    
    return {
      _id: String(job._id),
      workOrderId: String(job.workOrderId),
      workOrderNumber: workOrder?.workOrderNumber || '',
      title: job.title,
      description: job.description,
      hours: job.laborHoursBilled || job.laborHoursActual,
      total: job.total,
      laborTotal: job.laborTotal,
      partsTotal: job.partsTotal,
      vin: vehicle?.vin,
      year: vehicle?.year,
      make: vehicle?.make,
      model: vehicle?.model,
      engine: vehicle?.engineDescription,
      closedDate: workOrder?.closedDate,
      sourceSystem: job.provenance?.sourceSystem || 'unknown',
      shopId: job.shopId,
      score: scoreJob({
        ...job,
        closedDate: workOrder?.closedDate,
      }, query, shopId),
    };
  });

  results.sort((a, b) => b.score - a.score);

  return NextResponse.json({
    results: results.slice(0, limit),
    total: results.length,
    source: 'normalized',
    vehiclesSearched: vehicleIds.length,
    workOrdersSearched: workOrderIds.length,
    serviceJobsFound: serviceJobs.length,
  });
}
