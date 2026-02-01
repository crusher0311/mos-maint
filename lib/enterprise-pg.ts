import sql from "@/lib/db/postgres";

export interface EnterpriseAccount {
  id: string;
  name: string;
  shop_ids: number[];
  shared_mappings: Record<string, unknown> | null;
  shared_integrations: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

export interface RecommendationEvent {
  id: string;
  shop_id: string;
  enterprise_id: string | null;
  vin: string;
  vehicle_id: string | null;
  work_order_id: string;
  work_order_number: string | null;
  provider: "protractor" | "tekmetric";
  event_type: "recommendation_added" | "recommendation_sold";
  recommendation_type: "oem" | "dvi" | "carfax" | "shop" | "protractor";
  service_code: string | null;
  service_name: string;
  price: number | null;
  labor_price: number | null;
  parts_price: number | null;
  total_price: number | null;
  added_by: string | null;
  created_at: Date;
}

export async function getEnterpriseById(enterpriseId: string): Promise<EnterpriseAccount | null> {
  const results = await sql<EnterpriseAccount[]>`
    SELECT * FROM enterprise_accounts WHERE id = ${enterpriseId} LIMIT 1
  `;
  return results[0] || null;
}

export async function getEnterpriseByShopId(shopId: number): Promise<EnterpriseAccount | null> {
  const results = await sql<EnterpriseAccount[]>`
    SELECT * FROM enterprise_accounts 
    WHERE ${shopId} = ANY(shop_ids)
    LIMIT 1
  `;
  return results[0] || null;
}

export async function getEnterpriseByShopUUID(shopUUID: string): Promise<EnterpriseAccount | null> {
  const shopResult = await sql<{shop_id: string}[]>`
    SELECT shop_id FROM shops WHERE id = ${shopUUID} LIMIT 1
  `;
  
  if (!shopResult[0]?.shop_id) return null;
  
  const shopIntId = parseInt(shopResult[0].shop_id, 10);
  if (isNaN(shopIntId)) return null;
  
  return getEnterpriseByShopId(shopIntId);
}

export async function createEnterprise(name: string, shopIds: number[]): Promise<EnterpriseAccount> {
  const now = new Date();
  const results = await sql<EnterpriseAccount[]>`
    INSERT INTO enterprise_accounts (id, name, shop_ids, created_at, updated_at)
    VALUES (gen_random_uuid(), ${name}, ${shopIds}, ${now}, ${now})
    RETURNING *
  `;
  return results[0];
}

export async function addShopToEnterprise(enterpriseId: string, shopId: number): Promise<void> {
  await sql`
    UPDATE enterprise_accounts
    SET shop_ids = array_append(shop_ids, ${shopId}),
        updated_at = NOW()
    WHERE id = ${enterpriseId}
    AND NOT ${shopId} = ANY(shop_ids)
  `;
}

export async function removeShopFromEnterprise(enterpriseId: string, shopId: number): Promise<void> {
  await sql`
    UPDATE enterprise_accounts
    SET shop_ids = array_remove(shop_ids, ${shopId}),
        updated_at = NOW()
    WHERE id = ${enterpriseId}
  `;
}

export async function logRecommendationEvent(event: {
  shopId: string;
  vin: string;
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
}): Promise<void> {
  const enterprise = await getEnterpriseByShopUUID(event.shopId);
  const enterpriseId = enterprise?.id || null;

  await sql`
    INSERT INTO recommendation_events (
      id, shop_id, enterprise_id, vin, work_order_id, work_order_number,
      provider, event_type, recommendation_type, service_code, service_name,
      line_item_id, price, labor_price, parts_price, total_price, added_by, created_at
    ) VALUES (
      gen_random_uuid(), ${event.shopId}, ${enterpriseId}, ${event.vin},
      ${event.workOrderId}, ${event.workOrderNumber || null},
      ${event.provider}, ${event.eventType}, ${event.recommendationType},
      ${event.serviceCode || null}, ${event.serviceName},
      ${event.lineItemId || null}, ${event.price || null}, ${event.laborPrice || null},
      ${event.partsPrice || null}, ${event.totalPrice || null},
      ${event.addedBy || null}, NOW()
    )
  `;
}

export async function getEnterpriseAnalytics(
  enterpriseId: string,
  startDate?: Date,
  endDate?: Date
) {
  const enterprise = await getEnterpriseById(enterpriseId);
  if (!enterprise) return null;

  const shops = await sql`
    SELECT id, shop_id, name FROM shops WHERE shop_id::int = ANY(${enterprise.shop_ids})
  `;
  const shopUUIDs = shops.map(s => s.id);
  const shopMap = new Map(shops.map(s => [s.id, { name: s.name, shopId: Number(s.shop_id) }]));

  const results = shopUUIDs.length > 0 ? await sql`
    SELECT 
      re.shop_id,
      re.event_type,
      re.recommendation_type,
      COUNT(*) as count,
      COALESCE(SUM(re.total_price), 0) as total_revenue,
      COALESCE(SUM(re.labor_price), 0) as labor_revenue,
      COALESCE(SUM(re.parts_price), 0) as parts_revenue
    FROM recommendation_events re
    WHERE re.shop_id = ANY(${shopUUIDs})
    ${startDate ? sql`AND re.created_at >= ${startDate}` : sql``}
    ${endDate ? sql`AND re.created_at <= ${endDate}` : sql``}
    GROUP BY re.shop_id, re.event_type, re.recommendation_type
  ` : [];

  const shopStats = new Map<string, {
    shopId: number;
    shopUUID: string;
    shopName: string;
    jobsAdded: number;
    jobsSold: number;
    revenue: number;
    events: any[];
  }>();

  for (const shop of shops) {
    shopStats.set(shop.id, {
      shopId: Number(shop.shop_id),
      shopUUID: shop.id,
      shopName: shop.name || `Shop ${shop.shop_id}`,
      jobsAdded: 0,
      jobsSold: 0,
      revenue: 0,
      events: []
    });
  }

  let totalJobsAdded = 0;
  let totalJobsSold = 0;
  let totalRevenue = 0;

  for (const row of results) {
    const stat = shopStats.get(row.shop_id);
    if (stat) {
      const count = Number(row.count);
      const revenue = Number(row.total_revenue);
      
      stat.events.push({
        eventType: row.event_type,
        recommendationType: row.recommendation_type,
        count,
        totalRevenue: revenue,
        laborRevenue: Number(row.labor_revenue),
        partsRevenue: Number(row.parts_revenue)
      });

      if (row.event_type === 'recommendation_added') {
        stat.jobsAdded += count;
        totalJobsAdded += count;
      } else if (row.event_type === 'recommendation_sold') {
        stat.jobsSold += count;
        stat.revenue += revenue;
        totalJobsSold += count;
        totalRevenue += revenue;
      }
    }
  }

  const shopBreakdown = Array.from(shopStats.values())
    .sort((a, b) => b.revenue - a.revenue);

  return {
    enterprise: {
      id: enterprise.id,
      name: enterprise.name,
      shopCount: enterprise.shop_ids.length
    },
    summary: {
      totalJobsAdded,
      totalJobsSold,
      totalRevenue,
      avgRevenuePerShop: enterprise.shop_ids.length > 0 ? totalRevenue / enterprise.shop_ids.length : 0
    },
    shopBreakdown
  };
}

export async function getShopsForEnterprise(enterpriseId: string) {
  const enterprise = await getEnterpriseById(enterpriseId);
  if (!enterprise) return [];

  return sql`
    SELECT * FROM shops WHERE id = ANY(${enterprise.shop_ids})
  `;
}

export async function attributeRevenueFromWorkOrder(
  shopId: string,
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
  const addedEvents = await sql<RecommendationEvent[]>`
    SELECT * FROM recommendation_events
    WHERE shop_id = ${shopId}
      AND work_order_id = ${workOrderId}
      AND event_type = 'recommendation_added'
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
        WHERE shop_id = ${shopId}
          AND work_order_id = ${workOrderId}
          AND service_code = ${event.service_code}
          AND event_type = 'recommendation_sold'
        LIMIT 1
      `;

      if (alreadySold.length === 0) {
        await logRecommendationEvent({
          shopId,
          vin,
          workOrderId,
          provider,
          eventType: "recommendation_sold",
          recommendationType: event.recommendation_type,
          serviceCode: event.service_code || undefined,
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
