import sql from "@/lib/db/postgres";

export interface EnterpriseAccount {
  id?: string;
  name: string;
  shopIds: string[];
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
  id?: number;
  shopId: string;
  enterpriseId?: string;
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
  id?: number;
  shopId: string;
  enterpriseId?: string;
  date: Date;
  provider: string;
  recommendationType: string;
  jobsAdded: number;
  jobsSold: number;
  totalRevenue: number;
  laborRevenue: number;
  partsRevenue: number;
}

export async function getEnterpriseById(enterpriseId: string): Promise<EnterpriseAccount | null> {
  const result = await sql`
    SELECT id, name, shop_ids as "shopIds", shared_mappings as "sharedMappings",
           shared_integrations as "sharedIntegrations", created_at as "createdAt", updated_at as "updatedAt"
    FROM enterprise_accounts
    WHERE id = ${enterpriseId}
    LIMIT 1
  `;
  
  if (result.length === 0) return null;
  return result[0] as unknown as EnterpriseAccount;
}

export async function getEnterpriseByShopId(shopId: number | string): Promise<EnterpriseAccount | null> {
  const shopIdStr = String(shopId);
  const result = await sql`
    SELECT id, name, shop_ids as "shopIds", shared_mappings as "sharedMappings",
           shared_integrations as "sharedIntegrations", created_at as "createdAt", updated_at as "updatedAt"
    FROM enterprise_accounts
    WHERE ${shopIdStr} = ANY(shop_ids)
    LIMIT 1
  `;
  
  if (result.length === 0) return null;
  return result[0] as unknown as EnterpriseAccount;
}

export async function createEnterprise(name: string, shopIds: (number | string)[]): Promise<EnterpriseAccount> {
  const shopIdStrs = shopIds.map(String);
  
  const result = await sql`
    INSERT INTO enterprise_accounts (name, shop_ids)
    VALUES (${name}, ${shopIdStrs})
    RETURNING id, name, shop_ids as "shopIds", created_at as "createdAt", updated_at as "updatedAt"
  `;
  
  return result[0] as unknown as EnterpriseAccount;
}

export async function addShopToEnterprise(enterpriseId: string, shopId: number | string): Promise<void> {
  const shopIdStr = String(shopId);
  
  await sql`
    UPDATE enterprise_accounts
    SET shop_ids = array_append(shop_ids, ${shopIdStr}), updated_at = NOW()
    WHERE id = ${enterpriseId} AND NOT (${shopIdStr} = ANY(shop_ids))
  `;
}

export async function removeShopFromEnterprise(enterpriseId: string, shopId: number | string): Promise<void> {
  const shopIdStr = String(shopId);
  
  await sql`
    UPDATE enterprise_accounts
    SET shop_ids = array_remove(shop_ids, ${shopIdStr}), updated_at = NOW()
    WHERE id = ${enterpriseId}
  `;
}

export async function logRecommendationEvent(event: Omit<RecommendationEvent, "id" | "createdAt">): Promise<void> {
  let enterpriseId = event.enterpriseId;
  
  if (event.shopId && !enterpriseId) {
    const enterprise = await getEnterpriseByShopId(event.shopId);
    if (enterprise?.id) {
      enterpriseId = enterprise.id;
    }
  }
  
  await sql`
    INSERT INTO recommendation_events (
      shop_id, enterprise_id, vin, vehicle_id, work_order_id, work_order_number,
      provider, event_type, recommendation_type, service_code, service_name,
      line_item_id, price, labor_price, parts_price, total_price, added_by
    )
    VALUES (
      ${event.shopId}, ${enterpriseId || null}, ${event.vin}, ${event.vehicleId || null},
      ${event.workOrderId}, ${event.workOrderNumber || null}, ${event.provider},
      ${event.eventType}, ${event.recommendationType}, ${event.serviceCode || null},
      ${event.serviceName}, ${event.lineItemId || null}, ${event.price || null},
      ${event.laborPrice || null}, ${event.partsPrice || null}, ${event.totalPrice || null},
      ${event.addedBy || null}
    )
  `;
}

export async function getEnterpriseAnalytics(enterpriseId: string, startDate?: Date, endDate?: Date) {
  const enterprise = await getEnterpriseById(enterpriseId);
  if (!enterprise) return null;
  
  const shopIds = enterprise.shopIds;
  
  let events;
  if (startDate && endDate) {
    events = await sql`
      SELECT shop_id as "shopId", event_type as "eventType", recommendation_type as "recommendationType",
             COUNT(*) as count, SUM(COALESCE(total_price, 0)) as "totalRevenue",
             SUM(COALESCE(labor_price, 0)) as "laborRevenue", SUM(COALESCE(parts_price, 0)) as "partsRevenue"
      FROM recommendation_events
      WHERE shop_id = ANY(${shopIds}) AND created_at >= ${startDate} AND created_at <= ${endDate}
      GROUP BY shop_id, event_type, recommendation_type
    `;
  } else if (startDate) {
    events = await sql`
      SELECT shop_id as "shopId", event_type as "eventType", recommendation_type as "recommendationType",
             COUNT(*) as count, SUM(COALESCE(total_price, 0)) as "totalRevenue",
             SUM(COALESCE(labor_price, 0)) as "laborRevenue", SUM(COALESCE(parts_price, 0)) as "partsRevenue"
      FROM recommendation_events
      WHERE shop_id = ANY(${shopIds}) AND created_at >= ${startDate}
      GROUP BY shop_id, event_type, recommendation_type
    `;
  } else {
    events = await sql`
      SELECT shop_id as "shopId", event_type as "eventType", recommendation_type as "recommendationType",
             COUNT(*) as count, SUM(COALESCE(total_price, 0)) as "totalRevenue",
             SUM(COALESCE(labor_price, 0)) as "laborRevenue", SUM(COALESCE(parts_price, 0)) as "partsRevenue"
      FROM recommendation_events
      WHERE shop_id = ANY(${shopIds})
      GROUP BY shop_id, event_type, recommendation_type
    `;
  }
  
  const shops = await sql`
    SELECT shop_id as "shopId", name FROM shops WHERE shop_id = ANY(${shopIds})
  `;
  
  const shopMap = new Map(shops.map((s: Record<string, unknown>) => [String(s.shopId), s.name as string]));
  
  const shopBreakdownMap = new Map<string, {
    shopId: string;
    shopName: string;
    jobsAdded: number;
    jobsSold: number;
    revenue: number;
    events: unknown[];
  }>();
  
  let totalJobsAdded = 0;
  let totalJobsSold = 0;
  let totalRevenue = 0;
  
  for (const event of events) {
    const shopId = String(event.shopId);
    if (!shopBreakdownMap.has(shopId)) {
      shopBreakdownMap.set(shopId, {
        shopId,
        shopName: shopMap.get(shopId) || `Shop ${shopId}`,
        jobsAdded: 0,
        jobsSold: 0,
        revenue: 0,
        events: []
      });
    }
    
    const shop = shopBreakdownMap.get(shopId)!;
    shop.events.push({
      eventType: event.eventType,
      recommendationType: event.recommendationType,
      count: Number(event.count),
      totalRevenue: Number(event.totalRevenue),
      laborRevenue: Number(event.laborRevenue),
      partsRevenue: Number(event.partsRevenue)
    });
    
    if (event.eventType === "recommendation_added") {
      shop.jobsAdded += Number(event.count);
      totalJobsAdded += Number(event.count);
    } else if (event.eventType === "recommendation_sold") {
      shop.jobsSold += Number(event.count);
      shop.revenue += Number(event.totalRevenue);
      totalJobsSold += Number(event.count);
      totalRevenue += Number(event.totalRevenue);
    }
  }
  
  for (const shopId of shopIds) {
    if (!shopBreakdownMap.has(shopId)) {
      shopBreakdownMap.set(shopId, {
        shopId,
        shopName: shopMap.get(shopId) || `Shop ${shopId}`,
        jobsAdded: 0,
        jobsSold: 0,
        revenue: 0,
        events: []
      });
    }
  }
  
  const shopBreakdown = Array.from(shopBreakdownMap.values())
    .sort((a, b) => b.revenue - a.revenue);
  
  return {
    enterprise: {
      id: enterprise.id,
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

export async function getShopsForEnterprise(enterpriseId: string) {
  const enterprise = await getEnterpriseById(enterpriseId);
  if (!enterprise) return [];
  
  const shops = await sql`
    SELECT * FROM shops WHERE shop_id = ANY(${enterprise.shopIds})
  `;
  
  return shops;
}

export async function attributeRevenueFromWorkOrder(
  shopId: number | string,
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
  const shopIdStr = String(shopId);
  
  const addedEvents = await sql`
    SELECT * FROM recommendation_events
    WHERE shop_id = ${shopIdStr} AND work_order_id = ${String(workOrderId)} AND event_type = 'recommendation_added'
  `;
  
  if (addedEvents.length === 0) {
    return { matched: 0, revenue: 0 };
  }
  
  let matched = 0;
  let totalRevenue = 0;
  
  for (const event of addedEvents) {
    const eventCode = (event.service_code || "").toLowerCase();
    const matchedPkg = packageSummaries.find(pkg => 
      pkg.code.toLowerCase() === eventCode ||
      pkg.id === event.service_code ||
      (pkg.templateId && pkg.templateId.toLowerCase() === eventCode) ||
      pkg.title.toLowerCase() === (event.service_name || "").toLowerCase()
    );
    
    if (matchedPkg) {
      const alreadySold = await sql`
        SELECT id FROM recommendation_events
        WHERE shop_id = ${shopIdStr} AND work_order_id = ${String(workOrderId)}
          AND service_code = ${event.service_code} AND event_type = 'recommendation_sold'
        LIMIT 1
      `;
      
      if (alreadySold.length === 0) {
        await logRecommendationEvent({
          shopId: shopIdStr,
          vin,
          workOrderId: String(workOrderId),
          provider,
          eventType: "recommendation_sold",
          recommendationType: event.recommendation_type,
          serviceCode: event.service_code,
          serviceName: event.service_name,
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
