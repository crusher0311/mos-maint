// app/api/dashboard/data/route.ts
import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import sql from "@/lib/db/postgres";
import { getFeatureEntitlements, FeatureKey } from "@/lib/featureResolver";
import { getBatchQuickSpecs } from "@/lib/integrations/dataone-local";
import { getDashboardData, getArchivedVehicles } from "@/lib/dashboard-data-service";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const pageSize = Math.min(100, Math.max(10, parseInt(searchParams.get('pageSize') || '50', 10)));
    const search = searchParams.get('search')?.toLowerCase() || '';
    const showArchived = searchParams.get('archived') === 'true';
    
    const store = await cookies();
    const sid = store.get("sid")?.value ?? store.get("session_token")?.value;
    if (!sid) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const now = new Date();
    const sessRows = await sql`
      SELECT user_id, expires_at FROM sessions 
      WHERE token = ${sid} AND expires_at > ${now}
      LIMIT 1
    `;
    if (!sessRows[0]) {
      return NextResponse.json({ error: "Session expired" }, { status: 401 });
    }

    const userRows = await sql`
      SELECT id, email, role, shop_id FROM users WHERE id = ${sessRows[0].user_id} LIMIT 1
    `;
    const user = userRows[0];
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    const userShopId = user.shop_id;

    const shopRows = await sql`
      SELECT id, shop_id, settings FROM shops
      WHERE shop_id = ${String(userShopId)} OR shop_id = ${String(Number(userShopId))}
      LIMIT 1
    `;
    const shopConfig = shopRows[0];
    const settings = shopConfig?.settings || {};

    if (showArchived) {
      const archivedRows = await getArchivedVehicles(userShopId, search || undefined);
      
      const totalCount = archivedRows.length;
      const offset = (page - 1) * pageSize;
      const paginatedRows = archivedRows.slice(offset, offset + pageSize);

      return NextResponse.json({
        rows: paginatedRows,
        pagination: {
          page,
          pageSize,
          totalCount,
          totalPages: Math.ceil(totalCount / pageSize),
          hasNextPage: page < Math.ceil(totalCount / pageSize),
          hasPrevPage: page > 1,
        },
        user: {
          email: user.email,
          role: user.role,
          shopId: userShopId,
        },
      });
    }

    const dashboardResult = await getDashboardData(userShopId);
    let allRows = dashboardResult.rows;

    if (search) {
      allRows = allRows.filter((row) => {
        const searchFields = [
          row.displayName,
          row.displayVehicle,
          row.displayVin,
          row.displayRo?.toString(),
          row.af?.status
        ].filter(Boolean).map(s => s!.toLowerCase());
        return searchFields.some(field => field.includes(search));
      });
    }

    allRows.sort((a, b) => {
      const nameA = a.displayName || "";
      const nameB = b.displayName || "";
      return nameA.localeCompare(nameB);
    });

    const totalCount = allRows.length;
    const totalPages = Math.ceil(totalCount / pageSize);
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const paginatedRows = allRows.slice(startIndex, endIndex);

    const distanceUnit = settings?.preferences?.distanceUnit || "miles";
    
    const shopIdNum = typeof userShopId === 'string' ? parseInt(userShopId, 10) : userShopId;
    const entitlements = await getFeatureEntitlements(shopIdNum);
    const enabledFeatures: FeatureKey[] = (Object.keys(entitlements.effectiveFeatures) as FeatureKey[])
      .filter(key => entitlements.effectiveFeatures[key]);

    const vins = paginatedRows
      .map((r) => r.displayVin)
      .filter((v) => v && v.length === 17);
    const quickSpecs = await getBatchQuickSpecs(vins);
    
    const response = NextResponse.json({
      rows: paginatedRows,
      quickSpecs,
      pagination: {
        page,
        pageSize,
        totalCount,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1
      },
      user: {
        email: user.email,
        role: user.role,
        shopId: userShopId
      },
      smsType: dashboardResult.smsType || 'autoflow',
      distanceUnit,
      enabledFeatures
    });
    
    response.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    response.headers.set('Pragma', 'no-cache');
    response.headers.set('Expires', '0');
    
    return response;

  } catch (error) {
    console.error("Dashboard data error:", error);
    return NextResponse.json({ error: "Failed to fetch dashboard data" }, { status: 500 });
  }
}
