// app/api/dashboard/data/route.ts
import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import sql from "@/lib/db/postgres";
import { getFeatureEntitlements, FeatureKey } from "@/lib/featureResolver";
import { getBatchQuickSpecs } from "@/lib/integrations/dataone-local";

export async function GET(request: NextRequest) {
  try {
    // Parse pagination params
    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const pageSize = Math.min(100, Math.max(10, parseInt(searchParams.get('pageSize') || '50', 10)));
    const search = searchParams.get('search')?.toLowerCase() || '';
    const showArchived = searchParams.get('archived') === 'true';
    
    // Session check
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

    // Check shop SMS configuration
    const shopRows = await sql`
      SELECT id, shop_id, settings, tekmetric_shop_id, protractor_connection_id,
             trial_vin_limit, billing
      FROM shops
      WHERE shop_id = ${String(userShopId)} OR shop_id = ${String(Number(userShopId))}
      LIMIT 1
    `;
    const shopConfig = shopRows[0];
    const settings = shopConfig?.settings || {};
    const isAutoFlowConfigured = !!(settings?.autoflow?.apiKey || settings?.autoflowApiKey);
    const isProtractorPrimary = !!settings?.protractor?.configured;

    // If showing archived vehicles, fetch from vehicles collection directly
    if (showArchived) {
      let archivedQuery = sql`
        SELECT v.*, c.first_name, c.last_name, c.name as customer_name
        FROM vehicles v
        LEFT JOIN customers c ON v.customer_id = c.id
        WHERE v.shop_id = ${String(userShopId)}
          AND (v.status->>'active')::boolean IS NOT TRUE
      `;
      
      if (search) {
        archivedQuery = sql`
          SELECT v.*, c.first_name, c.last_name, c.name as customer_name
          FROM vehicles v
          LEFT JOIN customers c ON v.customer_id = c.id
          WHERE v.shop_id = ${String(userShopId)}
            AND (v.status->>'active')::boolean IS NOT TRUE
            AND (
              LOWER(v.vin) LIKE ${`%${search}%`}
              OR LOWER(v.make) LIKE ${`%${search}%`}
              OR LOWER(v.model) LIKE ${`%${search}%`}
              OR LOWER(c.name) LIKE ${`%${search}%`}
              OR LOWER(c.first_name) LIKE ${`%${search}%`}
              OR LOWER(c.last_name) LIKE ${`%${search}%`}
            )
        `;
      }

      const countRows = await sql`
        SELECT COUNT(*)::int as count FROM vehicles
        WHERE shop_id = ${String(userShopId)}
          AND (status->>'active')::boolean IS NOT TRUE
      `;
      const totalCount = countRows[0]?.count || 0;
      
      const offset = (page - 1) * pageSize;
      const archivedVehicles = search ? await sql`
        SELECT v.*, c.first_name, c.last_name, c.name as customer_name
        FROM vehicles v
        LEFT JOIN customers c ON v.customer_id = c.id
        WHERE v.shop_id = ${String(userShopId)}
          AND (v.status->>'active')::boolean IS NOT TRUE
          AND (
            LOWER(v.vin) LIKE ${`%${search}%`}
            OR LOWER(v.make) LIKE ${`%${search}%`}
            OR LOWER(v.model) LIKE ${`%${search}%`}
            OR LOWER(c.name) LIKE ${`%${search}%`}
            OR LOWER(c.first_name) LIKE ${`%${search}%`}
            OR LOWER(c.last_name) LIKE ${`%${search}%`}
          )
        ORDER BY (v.status->>'lastClosedAt')::timestamp DESC NULLS LAST, v.updated_at DESC
        LIMIT ${pageSize} OFFSET ${offset}
      ` : await sql`
        SELECT v.*, c.first_name, c.last_name, c.name as customer_name
        FROM vehicles v
        LEFT JOIN customers c ON v.customer_id = c.id
        WHERE v.shop_id = ${String(userShopId)}
          AND (v.status->>'active')::boolean IS NOT TRUE
        ORDER BY (v.status->>'lastClosedAt')::timestamp DESC NULLS LAST, v.updated_at DESC
        LIMIT ${pageSize} OFFSET ${offset}
      `;

      const rows = archivedVehicles.map((v: any) => ({
        updatedAt: v.status?.lastClosedAt || v.updated_at || new Date(),
        displayName: v.customer_name || v.first_name ? 
          `${v.first_name || ''} ${v.last_name || ''}`.trim() : 
          'Unknown Customer',
        displayVehicle: [v.year, v.make, v.model].filter(Boolean).join(' '),
        displayVin: v.vin,
        displayMiles: v.mileage || v.last_mileage || null,
        displayRo: v.tekmetric?.repairOrderNumber || null,
        dviDone: false,
        archived: true,
        af: {
          status: 'Archived',
          createdAt: v.status?.lastClosedAt || v.updated_at,
          miles: v.mileage || v.last_mileage || null,
        },
        vehicle: {
          year: v.year || null,
          make: v.make || null,
          model: v.model || null,
          engine: v.engine || null,
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
        user: {
          email: user.email,
          role: user.role,
          shopId: userShopId,
        },
      });
    }

    // Build rows from latest AutoFlow events per VIN (only if AutoFlow is configured)
    let autoflowRows: any[] = [];
    if (isAutoFlowConfigured) {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      
      // Fetch events and process in JS (PostgreSQL equivalent of MongoDB aggregation)
      const eventRows = await sql`
        SELECT e.*, 
               COALESCE(e.received_at, e.created_at) as created_at_date,
               UPPER(COALESCE(e.vehicle_vin, e.vin, e.payload->'vehicle'->>'vin')) as vin_norm,
               COALESCE(e.payload->'ticket'->>'status', e.status, e.payload->>'status', e.type) as status_raw
        FROM events e
        WHERE e.shop_id = ${String(userShopId)}
          AND e.provider = 'autoflow'
          AND COALESCE(e.received_at, e.created_at) >= ${thirtyDaysAgo}
        ORDER BY UPPER(COALESCE(e.vehicle_vin, e.vin, e.payload->'vehicle'->>'vin')) ASC,
                 COALESCE(e.received_at, e.created_at) DESC
      `;

      // Active statuses list
      const activeStatuses = ["CHECKED IN", "IN PROGRESS", "EST", "RACK ATTACK", 
        "Build Estimate (Workflow) and Presentation (Advisor)", "Authorized ready for work"];
      
      // Group by VIN and get latest, track active/close
      const vinGroups = new Map<string, { latest: any; lastActive: Date | null; lastClose: Date | null }>();
      
      for (const e of eventRows) {
        const vin = e.vin_norm;
        if (!vin) continue;
        
        const ticketStatus = e.payload?.ticket?.status;
        const createdAt = e.created_at_date;
        const isActive = activeStatuses.includes(ticketStatus);
        const isClose = ticketStatus === "Close";
        
        if (!vinGroups.has(vin)) {
          vinGroups.set(vin, { 
            latest: e, 
            lastActive: isActive ? createdAt : null,
            lastClose: isClose ? createdAt : null
          });
        } else {
          const group = vinGroups.get(vin)!;
          if (isActive && (!group.lastActive || createdAt > group.lastActive)) {
            group.lastActive = createdAt;
          }
          if (isClose && (!group.lastClose || createdAt > group.lastClose)) {
            group.lastClose = createdAt;
          }
        }
      }
      
      // Filter to active vehicles and map to display format
      for (const [vin, group] of vinGroups.entries()) {
        // Vehicle is active if: has active status AND (no close, OR last active is after last close)
        if (!group.lastActive) continue;
        if (group.lastClose && group.lastActive <= group.lastClose) continue;
        
        const e = group.latest;
        const payload = e.payload || {};
        
        // Check DVI presence
        const roNumber = payload.ticket?.invoice || payload.ticket?.id || payload.event?.invoice || e.ro_number;
        let dviDone = false;
        if (roNumber) {
          const dviCheck = await sql`
            SELECT 1 FROM dvi_results WHERE ro_number = ${String(roNumber)} LIMIT 1
          `;
          if (!dviCheck[0]) {
            const dviAltCheck = await sql`
              SELECT 1 FROM dvi WHERE ro_number = ${String(roNumber)} LIMIT 1
            `;
            dviDone = !!dviAltCheck[0];
          } else {
            dviDone = true;
          }
        }
        
        const firstName = payload.customer?.firstname || '';
        const lastName = payload.customer?.lastname || '';
        const fullName = `${firstName} ${lastName}`.trim() || payload.customer?.name || null;
        
        const vYear = payload.vehicle?.year;
        const vMake = payload.vehicle?.make || '';
        const vModel = payload.vehicle?.model || '';
        const displayVehicle = [vYear, vMake, vModel].filter(Boolean).join(' ').trim();
        
        const miles = payload.ticket?.mileage || payload.mileage || 
                      payload.vehicle?.mileage || payload.vehicle?.miles || 
                      payload.vehicle?.odometer || null;
        
        autoflowRows.push({
          updatedAt: e.created_at_date || new Date(),
          displayName: fullName,
          displayVehicle,
          displayVin: vin,
          displayMiles: miles,
          displayRo: roNumber,
          dviDone,
          af: {
            createdAt: e.created_at_date,
            status: e.status_raw,
            miles
          },
          vehicle: {
            year: payload.vehicle?.year || null,
            make: payload.vehicle?.make || null,
            model: payload.vehicle?.model || null,
            engine: payload.vehicle?.engine || null
          }
        });
      }
      
      // Sort by name
      autoflowRows.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
    }

    // Fetch shop preferences for workflow stage filtering
    const DEFAULT_WORKFLOW_STAGES = [
      "InspectionInProgress", "Unassigned", "WorkAuthorized", "EstimateCompleted",
      "EstimatePresented", "EstimateRejected", "WaitingForParts", "VehicleInBay",
      "VehicleReadyForPickup", "Deferred", "WorkCompleted"
    ];
    const allowedStages = settings?.preferences?.workflowStages || DEFAULT_WORKFLOW_STAGES;
    const TERMINAL_WORKFLOW_STAGES = ["Invoiced", "Closed", "Void", "ClosedInvoiced", "ClosedVoid"];

    // Fetch Protractor work orders
    const protractorWoRows = await sql`
      SELECT wo.*, pv.year as vehicle_year, pv.make as vehicle_make, pv.model as vehicle_model,
             pv.engine as vehicle_engine, pv.mileage as vehicle_mileage, pv.odometer as vehicle_odometer,
             pv.customer
      FROM protractor_work_orders wo
      LEFT JOIN protractor_vehicles pv ON wo.vin = pv.vin AND wo.shop_id = pv.shop_id
      WHERE wo.shop_id = ${String(userShopId)}
        AND wo.vin IS NOT NULL
        AND wo.completed IS NOT TRUE
        AND wo.status NOT IN ('Invoiced', 'Closed', 'Void')
        AND wo.workflow_stage = ANY(${allowedStages})
        AND wo.workflow_stage != ALL(${TERMINAL_WORKFLOW_STAGES})
      ORDER BY wo.fetched_at DESC
    `;

    const protractorRows = protractorWoRows.map((wo: any) => {
      const displayName = wo.customer?.name || wo.company_name || wo.contact_name || 'Unknown Customer';
      const vYear = wo.vehicle_year;
      const vMake = wo.vehicle_make || '';
      const vModel = wo.vehicle_model || '';
      const displayVehicle = [vYear, vMake, vModel].filter(Boolean).join(' ').trim();
      const miles = wo.vehicle_mileage || wo.odometer || wo.vehicle_odometer || null;
      
      return {
        updatedAt: wo.fetched_at || new Date(),
        displayName,
        displayVehicle,
        displayVin: wo.vin,
        displayMiles: miles,
        displayRo: wo.work_order_number,
        workOrderGuid: wo.work_order_guid,
        dviDone: false,
        source: "protractor",
        af: {
          status: wo.workflow_stage || "In Progress",
          createdAt: wo.fetched_at,
          miles
        },
        vehicle: {
          year: wo.vehicle_year || null,
          make: wo.vehicle_make || null,
          model: wo.vehicle_model || null,
          engine: wo.vehicle_engine || null
        }
      };
    });

    // Fetch Tekmetric work orders
    const TEKMETRIC_ALLOWED_STATUSES = ["Estimate", "Estimates", "Work-In-Progress", "Complete", "Completed"];
    const tekmetricLabelFilter = settings?.preferences?.tekmetricLabels || [];
    
    let tekmetricWoRows;
    if (tekmetricLabelFilter.length > 0) {
      tekmetricWoRows = await sql`
        SELECT * FROM tekmetric_work_orders
        WHERE shop_id = ${String(userShopId)}
          AND vin IS NOT NULL
          AND status = ANY(${TEKMETRIC_ALLOWED_STATUSES})
          AND label = ANY(${tekmetricLabelFilter})
        ORDER BY fetched_at DESC
      `;
    } else {
      tekmetricWoRows = await sql`
        SELECT * FROM tekmetric_work_orders
        WHERE shop_id = ${String(userShopId)}
          AND vin IS NOT NULL
          AND status = ANY(${TEKMETRIC_ALLOWED_STATUSES})
        ORDER BY fetched_at DESC
      `;
    }

    const tekmetricRows = tekmetricWoRows.map((wo: any) => {
      const vYear = wo.vehicle_year;
      const vMake = wo.vehicle_make || '';
      const vModel = wo.vehicle_model || '';
      const displayVehicle = [vYear, vMake, vModel].filter(Boolean).join(' ').trim();
      const displayStatus = (wo.label && wo.label !== '') ? wo.label : (wo.status || 'Open');
      
      return {
        updatedAt: wo.fetched_at || new Date(),
        displayName: wo.customer_name || 'Unknown Customer',
        displayVehicle,
        displayVin: wo.vin,
        displayMiles: wo.odometer,
        displayRo: wo.work_order_number,
        workOrderId: wo.work_order_id,
        dviDone: wo.dvi_done || false,
        source: "tekmetric",
        displayStatus,
        label: wo.label || null,
        labelColor: wo.label_color || null,
        af: {
          status: wo.status || 'Open',
          createdAt: wo.fetched_at,
          miles: wo.odometer
        },
        vehicle: {
          year: wo.vehicle_year || null,
          make: wo.vehicle_make || null,
          model: wo.vehicle_model || null,
          engine: wo.vehicle_engine || null
        }
      };
    });

    // Combine all rows - each work order shows as its own row (no VIN deduplication)
    const seenWorkOrders = new Set<string>();
    let allRows: any[] = [];
    
    const rowSources = isProtractorPrimary 
      ? [...protractorRows, ...tekmetricRows]
      : [...autoflowRows, ...protractorRows, ...tekmetricRows];
    
    for (const row of rowSources) {
      const woKey = `${row.source || 'unknown'}-${row.displayRo || row.workOrderGuid || row.displayVin}`;
      if (!seenWorkOrders.has(woKey)) {
        seenWorkOrders.add(woKey);
        allRows.push(row);
      }
    }

    // Filter to only show vehicles with mileage data (if preference is enabled)
    const showOnlyWithMileage = settings?.preferences?.showOnlyWithMileage !== false;
    if (showOnlyWithMileage) {
      allRows = allRows.filter((row: any) => {
        const miles = row.displayMiles ?? row.af?.miles;
        return miles != null && miles > 0;
      });
    }

    // Apply search filter if provided
    if (search) {
      allRows = allRows.filter((row: any) => {
        const searchFields = [
          row.displayName,
          row.displayVehicle,
          row.displayVin,
          row.displayRo?.toString(),
          row.af?.status
        ].filter(Boolean).map(s => s.toLowerCase());
        return searchFields.some(field => field.includes(search));
      });
    }

    // Sort alphabetically by customer name
    allRows.sort((a: any, b: any) => {
      const nameA = a.displayName || "";
      const nameB = b.displayName || "";
      return nameA.localeCompare(nameB);
    });

    // Calculate pagination
    const totalCount = allRows.length;
    const totalPages = Math.ceil(totalCount / pageSize);
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const paginatedRows = allRows.slice(startIndex, endIndex);

    // Determine which SMS integration is active for this shop
    let smsType = "autoflow";
    if (settings?.protractor?.configured) {
      smsType = "protractor";
    } else if (settings?.tekmetric?.configured) {
      smsType = "tekmetric";
    }
    
    const distanceUnit = settings?.preferences?.distanceUnit || "miles";
    
    // Get enabled features for this shop from featureResolver
    const shopIdNum = typeof userShopId === 'string' ? parseInt(userShopId, 10) : userShopId;
    const entitlements = await getFeatureEntitlements(shopIdNum);
    const enabledFeatures: FeatureKey[] = (Object.keys(entitlements.effectiveFeatures) as FeatureKey[])
      .filter(key => entitlements.effectiveFeatures[key]);

    // Pre-load quick specs for all VINs on this page
    const vins = paginatedRows
      .map((r: any) => r.displayVin)
      .filter((v: string) => v && v.length === 17);
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
      smsType,
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
