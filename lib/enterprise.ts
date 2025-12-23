import { getDb } from "./mongo";
import { ObjectId } from "mongodb";

export interface EnterpriseAccount {
  _id?: ObjectId;
  name: string;
  shopIds: number[];
  sharedMappings?: {
    cannedJobs: Record<string, string>;
    updatedAt: Date;
  };
  sharedIntegrations?: {
    protractor?: {
      baseUrl: string;
      apiKey: string;
    };
    tekmetric?: {
      shopId: number;
    };
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface RecommendationEvent {
  _id?: ObjectId;
  shopId: number;
  enterpriseId?: ObjectId;
  vin: string;
  vehicleId?: string;
  workOrderId: string;
  workOrderNumber?: string;
  provider: "protractor" | "tekmetric";
  eventType: "recommendation_added" | "recommendation_sold";
  recommendationType: "oem" | "dvi" | "carfax" | "shop" | "protractor";
  serviceCode?: string;
  serviceName: string;
  lineItemId?: string;
  price?: number;
  laborPrice?: number;
  partsPrice?: number;
  totalPrice?: number;
  addedBy?: string;
  createdAt: Date;
}

export interface RevenueAttributionDaily {
  _id?: ObjectId;
  shopId: number;
  enterpriseId?: ObjectId;
  date: Date;
  provider: string;
  recommendationType: string;
  jobsAdded: number;
  jobsSold: number;
  totalRevenue: number;
  laborRevenue: number;
  partsRevenue: number;
}

export async function getEnterpriseById(enterpriseId: ObjectId | string) {
  const db = await getDb();
  const id = typeof enterpriseId === "string" ? new ObjectId(enterpriseId) : enterpriseId;
  return db.collection<EnterpriseAccount>("enterprise_accounts").findOne({ _id: id });
}

export async function getEnterpriseByShopId(shopId: number) {
  const db = await getDb();
  return db.collection<EnterpriseAccount>("enterprise_accounts").findOne({ 
    shopIds: shopId 
  });
}

export async function createEnterprise(name: string, shopIds: number[]) {
  const db = await getDb();
  const now = new Date();
  const doc: EnterpriseAccount = {
    name,
    shopIds,
    createdAt: now,
    updatedAt: now,
  };
  const result = await db.collection<EnterpriseAccount>("enterprise_accounts").insertOne(doc);
  return { ...doc, _id: result.insertedId };
}

export async function addShopToEnterprise(enterpriseId: ObjectId | string, shopId: number) {
  const db = await getDb();
  const id = typeof enterpriseId === "string" ? new ObjectId(enterpriseId) : enterpriseId;
  return db.collection("enterprise_accounts").updateOne(
    { _id: id },
    { 
      $addToSet: { shopIds: shopId },
      $set: { updatedAt: new Date() }
    }
  );
}

export async function removeShopFromEnterprise(enterpriseId: ObjectId | string, shopId: number) {
  const db = await getDb();
  const id = typeof enterpriseId === "string" ? new ObjectId(enterpriseId) : enterpriseId;
  return db.collection("enterprise_accounts").updateOne(
    { _id: id },
    { 
      $pull: { shopIds: shopId } as any,
      $set: { updatedAt: new Date() }
    }
  );
}

export async function logRecommendationEvent(event: Omit<RecommendationEvent, "_id" | "createdAt">) {
  const db = await getDb();
  const doc: RecommendationEvent = {
    ...event,
    createdAt: new Date(),
  };
  
  if (event.shopId) {
    const enterprise = await getEnterpriseByShopId(event.shopId);
    if (enterprise?._id) {
      doc.enterpriseId = enterprise._id;
    }
  }
  
  return db.collection<RecommendationEvent>("recommendation_events").insertOne(doc);
}

export async function getEnterpriseAnalytics(enterpriseId: ObjectId | string, startDate?: Date, endDate?: Date) {
  const db = await getDb();
  const id = typeof enterpriseId === "string" ? new ObjectId(enterpriseId) : enterpriseId;
  
  const enterprise = await getEnterpriseById(id);
  if (!enterprise) return null;
  
  const dateFilter: any = {};
  if (startDate) dateFilter.$gte = startDate;
  if (endDate) dateFilter.$lte = endDate;
  
  const matchStage: any = { 
    shopId: { $in: enterprise.shopIds }
  };
  if (startDate || endDate) {
    matchStage.createdAt = dateFilter;
  }
  
  const pipeline = [
    { $match: matchStage },
    {
      $group: {
        _id: {
          shopId: "$shopId",
          eventType: "$eventType",
          recommendationType: "$recommendationType"
        },
        count: { $sum: 1 },
        totalRevenue: { $sum: { $ifNull: ["$totalPrice", 0] } },
        laborRevenue: { $sum: { $ifNull: ["$laborPrice", 0] } },
        partsRevenue: { $sum: { $ifNull: ["$partsPrice", 0] } }
      }
    },
    {
      $group: {
        _id: "$_id.shopId",
        events: {
          $push: {
            eventType: "$_id.eventType",
            recommendationType: "$_id.recommendationType",
            count: "$count",
            totalRevenue: "$totalRevenue",
            laborRevenue: "$laborRevenue",
            partsRevenue: "$partsRevenue"
          }
        },
        totalJobs: { $sum: "$count" },
        totalRevenue: { $sum: "$totalRevenue" }
      }
    }
  ];
  
  const results = await db.collection<RecommendationEvent>("recommendation_events")
    .aggregate(pipeline)
    .toArray();
  
  const shops = await db.collection("shops")
    .find({ shopId: { $in: enterprise.shopIds } })
    .toArray();
  
  const shopMap = new Map(shops.map(s => [s.shopId, s.name]));
  
  let totalJobsAdded = 0;
  let totalJobsSold = 0;
  let totalRevenue = 0;
  
  const shopBreakdown = results.map((r: any) => {
    const added = r.events.filter((e: any) => e.eventType === "recommendation_added")
      .reduce((sum: number, e: any) => sum + e.count, 0);
    const sold = r.events.filter((e: any) => e.eventType === "recommendation_sold")
      .reduce((sum: number, e: any) => sum + e.count, 0);
    const revenue = r.events.filter((e: any) => e.eventType === "recommendation_sold")
      .reduce((sum: number, e: any) => sum + e.totalRevenue, 0);
    
    totalJobsAdded += added;
    totalJobsSold += sold;
    totalRevenue += revenue;
    
    return {
      shopId: r._id,
      shopName: shopMap.get(r._id) || `Shop ${r._id}`,
      jobsAdded: added,
      jobsSold: sold,
      revenue: revenue,
      events: r.events
    };
  });
  
  for (const shopId of enterprise.shopIds) {
    if (!shopBreakdown.find((s: any) => s.shopId === shopId)) {
      shopBreakdown.push({
        shopId,
        shopName: shopMap.get(shopId) || `Shop ${shopId}`,
        jobsAdded: 0,
        jobsSold: 0,
        revenue: 0,
        events: []
      });
    }
  }
  
  shopBreakdown.sort((a: any, b: any) => b.revenue - a.revenue);
  
  return {
    enterprise: {
      id: enterprise._id,
      name: enterprise.name,
      shopCount: enterprise.shopIds.length
    },
    summary: {
      totalJobsAdded,
      totalJobsSold,
      totalRevenue,
      avgRevenuePerShop: enterprise.shopIds.length > 0 ? totalRevenue / enterprise.shopIds.length : 0
    },
    shopBreakdown
  };
}

export async function getShopsForEnterprise(enterpriseId: ObjectId | string) {
  const db = await getDb();
  const enterprise = await getEnterpriseById(enterpriseId);
  if (!enterprise) return [];
  
  return db.collection("shops")
    .find({ shopId: { $in: enterprise.shopIds } })
    .toArray();
}

export async function attributeRevenueFromWorkOrder(
  shopId: number,
  workOrderId: string,
  vin: string,
  packageSummaries: Array<{
    id: string;
    templateId?: string;
    code: string;
    title: string;
    laborTotal: number;
    partsTotal: number;
    otherTotal: number;
    total: number;
  }>,
  provider: "protractor" | "tekmetric" = "protractor"
) {
  const db = await getDb();
  
  const addedEvents = await db.collection<RecommendationEvent>("recommendation_events")
    .find({
      shopId,
      workOrderId: String(workOrderId),
      eventType: "recommendation_added"
    })
    .toArray();
  
  if (addedEvents.length === 0) {
    return { matched: 0, revenue: 0 };
  }
  
  let matched = 0;
  let totalRevenue = 0;
  
  for (const event of addedEvents) {
    const eventCode = (event.serviceCode || "").toLowerCase();
    const matchedPkg = packageSummaries.find(pkg => 
      pkg.code.toLowerCase() === eventCode ||
      pkg.id === event.serviceCode ||
      (pkg.templateId && pkg.templateId.toLowerCase() === eventCode) ||
      pkg.title.toLowerCase() === (event.serviceName || "").toLowerCase()
    );
    
    if (matchedPkg) {
      const alreadySold = await db.collection<RecommendationEvent>("recommendation_events").findOne({
        shopId,
        workOrderId: String(workOrderId),
        serviceCode: event.serviceCode,
        eventType: "recommendation_sold"
      });
      
      if (!alreadySold) {
        await logRecommendationEvent({
          shopId,
          vin,
          workOrderId: String(workOrderId),
          provider,
          eventType: "recommendation_sold",
          recommendationType: event.recommendationType,
          serviceCode: event.serviceCode,
          serviceName: event.serviceName,
          laborPrice: matchedPkg.laborTotal,
          partsPrice: matchedPkg.partsTotal,
          totalPrice: matchedPkg.total,
        });
        
        matched++;
        totalRevenue += matchedPkg.total;
      }
    }
  }
  
  return { matched, revenue: totalRevenue };
}
