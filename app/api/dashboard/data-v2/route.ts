import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import sql from "@/lib/db/postgres";

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
      SELECT * FROM sessions WHERE token = ${sid} AND expires_at > ${now} LIMIT 1
    `;
    const sess = sessRows[0];
    if (!sess) {
      return NextResponse.json({ error: "Session expired" }, { status: 401 });
    }

    const userRows = await sql`
      SELECT id, email, role, shop_id FROM users WHERE id = ${sess.user_id} LIMIT 1
    `;
    const user = userRows[0];
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const shopId = user.shop_id;
    const shopRows = await sql`SELECT * FROM shops WHERE shop_id = ${shopId} LIMIT 1`;
    const shop = shopRows[0];
    const settings = shop?.settings || {};

    if (showArchived) {
      let archivedWOs;
      if (search) {
        const searchPattern = `%${search}%`;
        archivedWOs = await sql`
          SELECT * FROM normalized_work_orders
          WHERE shop_id = ${shopId}
            AND status IN ('Invoiced', 'Closed', 'Void', 'Invoice')
            AND (
              vin ILIKE ${searchPattern}
              OR vehicle->>'make' ILIKE ${searchPattern}
              OR vehicle->>'model' ILIKE ${searchPattern}
              OR customer->>'name' ILIKE ${searchPattern}
            )
          ORDER BY COALESCE(closed_at, updated_at) DESC
          OFFSET ${(page - 1) * pageSize}
          LIMIT ${pageSize}
        `;
      } else {
        archivedWOs = await sql`
          SELECT * FROM normalized_work_orders
          WHERE shop_id = ${shopId}
            AND status IN ('Invoiced', 'Closed', 'Void', 'Invoice')
          ORDER BY COALESCE(closed_at, updated_at) DESC
          OFFSET ${(page - 1) * pageSize}
          LIMIT ${pageSize}
        `;
      }

      const totalCountRows = await sql`
        SELECT COUNT(*)::int as count FROM normalized_work_orders
        WHERE shop_id = ${shopId} AND status IN ('Invoiced', 'Closed', 'Void', 'Invoice')
      `;
      const totalCount = totalCountRows[0]?.count || 0;

      const rows = archivedWOs.map((wo: any) => ({
        updatedAt: wo.closed_at || wo.updated_at || new Date(),
        displayName: wo.customer?.name || 'Unknown Customer',
        displayVehicle: [wo.vehicle?.year, wo.vehicle?.make, wo.vehicle?.model].filter(Boolean).join(' '),
        displayVin: wo.vin,
        displayMiles: wo.mileage_out || wo.mileage_in || null,
        displayRo: wo.source_id,
        dviDone: false,
        archived: true,
        source: wo.sms_type,
        af: {
          status: 'Archived',
          createdAt: wo.closed_at || wo.updated_at,
          miles: wo.mileage_out || wo.mileage_in || null,
        },
        vehicle: {
          year: wo.vehicle?.year || null,
          make: wo.vehicle?.make || null,
          model: wo.vehicle?.model || null,
          engine: wo.vehicle?.engine || null,
        },
      }));

      return NextResponse.json({
        rows,
        pagination: {
          page,
          pageSize,
          totalCount,
          totalPages: Math.ceil(totalCount / pageSize),
          hasNextPage: page < Math.ceil(totalCount / pageSize),
          hasPrevPage: page > 1,
        },
        user: { email: user.email, role: user.role, shopId: user.shop_id },
        normalized: true
      });
    }

    const shopPrefs = settings.preferences || {};
    const ACTIVE_STATUSES = [
      "InspectionInProgress", "Unassigned", "WorkAuthorized", "EstimateCompleted",
      "EstimatePresented", "WorkCompleted", "Estimate", "Work-In-Progress", "Complete",
      "CHECKED IN", "IN PROGRESS", "EST"
    ];
    const workflowStages = shopPrefs.workflowStages || ACTIVE_STATUSES;

    let workOrders = await sql`
      SELECT * FROM normalized_work_orders
      WHERE shop_id = ${shopId}
        AND status = ANY(${workflowStages})
        AND status NOT IN ('Invoiced', 'Closed', 'Void', 'Invoice')
        AND vin IS NOT NULL
        AND (mileage_in > 0 OR mileage_out > 0 OR ${shopPrefs.showOnlyWithMileage === false})
      ORDER BY updated_at DESC
    `;

    let filteredWorkOrders = workOrders as any[];
    if (search) {
      filteredWorkOrders = filteredWorkOrders.filter((wo: any) => {
        const searchFields = [
          wo.customer?.name,
          wo.vehicle?.make,
          wo.vehicle?.model,
          wo.vin,
          wo.source_id?.toString(),
          wo.status
        ].filter(Boolean).map((s: any) => String(s).toLowerCase());
        return searchFields.some(field => field.includes(search));
      });
    }

    const rows = filteredWorkOrders.map((wo: any) => ({
      updatedAt: wo.updated_at || new Date(),
      displayName: wo.customer?.name || 'Unknown Customer',
      displayVehicle: [wo.vehicle?.year, wo.vehicle?.make, wo.vehicle?.model].filter(Boolean).join(' '),
      displayVin: wo.vin,
      displayMiles: wo.mileage_out || wo.mileage_in || null,
      displayRo: wo.source_id,
      workOrderId: wo.source_id,
      workOrderGuid: wo.source_id,
      dviDone: wo.has_dvi || false,
      source: wo.sms_type,
      displayStatus: wo.label || wo.status,
      af: {
        status: wo.status,
        createdAt: wo.created_at,
        miles: wo.mileage_out || wo.mileage_in || null
      },
      vehicle: {
        year: wo.vehicle?.year || null,
        make: wo.vehicle?.make || null,
        model: wo.vehicle?.model || null,
        engine: wo.vehicle?.engine || null,
      }
    }));

    rows.sort((a: any, b: any) => {
      const nameA = a.displayName || "";
      const nameB = b.displayName || "";
      return nameA.localeCompare(nameB);
    });

    const totalCount = rows.length;
    const totalPages = Math.ceil(totalCount / pageSize);
    const paginatedRows = rows.slice((page - 1) * pageSize, page * pageSize);

    let smsType = "autoflow";
    if (settings.protractor?.configured) smsType = "protractor";
    else if (settings.tekmetric?.configured) smsType = "tekmetric";

    const response = NextResponse.json({
      rows: paginatedRows,
      pagination: {
        page,
        pageSize,
        totalCount,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1
      },
      user: { email: user.email, role: user.role, shopId: user.shop_id },
      smsType,
      distanceUnit: shopPrefs.distanceUnit || "miles",
      normalized: true
    });
    
    response.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    return response;

  } catch (error) {
    console.error("Dashboard data v2 error:", error);
    return NextResponse.json({ error: "Failed to fetch dashboard data" }, { status: 500 });
  }
}
