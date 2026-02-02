import sql from "@/lib/db/postgres";
import { integrationFacade, integrationRegistry } from "@/lib/integrations/core/facade";
import type { SMSProvider } from "@/lib/integrations/core/types";

export interface DashboardRow {
  updatedAt: Date;
  displayName: string | null;
  displayVehicle: string;
  displayVin: string;
  displayMiles: number | null;
  displayRo: string | null;
  workOrderId?: string;
  dviDone: boolean;
  source: SMSProvider | 'autoflow';
  displayStatus?: string;
  label?: string | null;
  labelColor?: string | null;
  archived?: boolean;
  af?: {
    status: string;
    createdAt: Date;
    miles: number | null;
  };
  vehicle?: {
    year: number | null;
    make: string | null;
    model: string | null;
    engine: string | null;
  };
}

export interface DashboardDataResult {
  rows: DashboardRow[];
  smsType: SMSProvider | 'autoflow' | null;
  configuredProviders: SMSProvider[];
}

interface ShopConfig {
  id: string;
  shopId: string;
  settings: any;
  isAutoFlowConfigured: boolean;
  isProtractorConfigured: boolean;
  isTekmetricConfigured: boolean;
}

async function getShopConfig(shopId: string | number): Promise<ShopConfig | null> {
  const rows = await sql`
    SELECT id, shop_id, settings, tekmetric, protractor, autoflow
    FROM shops
    WHERE shop_id = ${String(shopId)} OR shop_id = ${String(Number(shopId))}
    LIMIT 1
  `;
  
  if (!rows[0]) return null;
  
  const shop = rows[0] as any;
  const settings = shop.settings || {};
  
  return {
    id: shop.id,
    shopId: shop.shop_id,
    settings,
    isAutoFlowConfigured: !!(settings?.autoflow?.apiKey || settings?.autoflowApiKey || shop.autoflow?.apiKey),
    isProtractorConfigured: !!(settings?.protractor?.configured || shop.protractor?.configured),
    isTekmetricConfigured: !!(shop.tekmetric?.shopId || settings?.tekmetric?.shopId),
  };
}

async function fetchAutoFlowRows(shopId: string, shopUuid: string): Promise<DashboardRow[]> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  
  const eventRows = await sql`
    SELECT e.*, 
           COALESCE(e.received_at, e.created_at) as created_at_date,
           UPPER(COALESCE(e.vehicle_vin, e.vin, e.payload->'vehicle'->>'vin')) as vin_norm,
           COALESCE(e.payload->'ticket'->>'status', e.status, e.payload->>'status', e.type) as status_raw
    FROM events e
    WHERE e.shop_id = ${shopUuid}
      AND e.provider = 'autoflow'
      AND COALESCE(e.received_at, e.created_at) >= ${thirtyDaysAgo}
    ORDER BY UPPER(COALESCE(e.vehicle_vin, e.vin, e.payload->'vehicle'->>'vin')) ASC,
             COALESCE(e.received_at, e.created_at) DESC
  `;

  const activeStatuses = ["CHECKED IN", "IN PROGRESS", "EST", "RACK ATTACK", 
    "Build Estimate (Workflow) and Presentation (Advisor)", "Authorized ready for work"];
  
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
  
  const rows: DashboardRow[] = [];
  
  for (const [vin, group] of vinGroups.entries()) {
    if (!group.lastActive) continue;
    if (group.lastClose && group.lastActive <= group.lastClose) continue;
    
    const e = group.latest;
    const payload = e.payload || {};
    
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
    
    rows.push({
      updatedAt: e.created_at_date || new Date(),
      displayName: fullName,
      displayVehicle,
      displayVin: vin,
      displayMiles: miles,
      displayRo: roNumber,
      dviDone,
      source: 'autoflow',
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
  
  rows.sort((a, b) => (a.displayName || '').localeCompare(b.displayName || ''));
  return rows;
}

async function fetchProtractorRows(shopId: string, settings: any): Promise<DashboardRow[]> {
  const DEFAULT_WORKFLOW_STAGES = [
    "InspectionInProgress", "Unassigned", "WorkAuthorized", "EstimateCompleted",
    "EstimatePresented", "EstimateRejected", "WaitingForParts", "VehicleInBay",
    "VehicleReadyForPickup", "Deferred", "WorkCompleted"
  ];
  const allowedStages = settings?.preferences?.workflowStages || DEFAULT_WORKFLOW_STAGES;
  const TERMINAL_WORKFLOW_STAGES = ["Invoiced", "Closed", "Void", "ClosedInvoiced", "ClosedVoid"];

  const protractorWoRows = await sql`
    SELECT wo.*, pv.year as vehicle_year, pv.make as vehicle_make, pv.model as vehicle_model,
           pv.engine as vehicle_engine, pv.mileage as vehicle_mileage, pv.odometer as vehicle_odometer,
           pv.customer
    FROM protractor_work_orders wo
    LEFT JOIN protractor_vehicles pv ON wo.vin = pv.vin AND wo.shop_id = pv.shop_id
    WHERE wo.shop_id = ${shopId}
      AND wo.vin IS NOT NULL
      AND wo.completed IS NOT TRUE
      AND wo.status NOT IN ('Invoiced', 'Closed', 'Void')
      AND wo.workflow_stage = ANY(${allowedStages})
      AND wo.workflow_stage != ALL(${TERMINAL_WORKFLOW_STAGES})
    ORDER BY wo.fetched_at DESC
  `;

  return protractorWoRows.map((wo: any) => {
    const vYear = wo.vehicle_year;
    const vMake = wo.vehicle_make || '';
    const vModel = wo.vehicle_model || '';
    const displayVehicle = [vYear, vMake, vModel].filter(Boolean).join(' ').trim();
    const mileage = wo.vehicle_mileage || wo.vehicle_odometer || wo.mileage || null;
    const customerData = wo.customer || {};
    const fullName = customerData.name || 
      `${customerData.firstName || ''} ${customerData.lastName || ''}`.trim() || 
      'Unknown Customer';

    return {
      updatedAt: wo.fetched_at || new Date(),
      displayName: fullName,
      displayVehicle,
      displayVin: wo.vin,
      displayMiles: mileage,
      displayRo: wo.work_order_number?.toString() || wo.invoice_number || null,
      workOrderId: wo.id?.toString(),
      dviDone: wo.dvi_done || false,
      source: 'protractor' as SMSProvider,
      displayStatus: wo.workflow_stage || wo.status || 'Open',
      af: {
        status: wo.workflow_stage || wo.status || 'Open',
        createdAt: wo.fetched_at,
        miles: mileage
      },
      vehicle: {
        year: wo.vehicle_year || null,
        make: wo.vehicle_make || null,
        model: wo.vehicle_model || null,
        engine: wo.vehicle_engine || null
      }
    };
  });
}

async function fetchTekmetricRows(shopUuid: string, settings: any): Promise<DashboardRow[]> {
  const TEKMETRIC_ALLOWED_STATUSES = ["Estimate", "Estimates", "Work-In-Progress", "Complete", "Completed"];
  const tekmetricLabelFilter = settings?.preferences?.tekmetricLabels || [];
  
  let tekmetricWoRows: any[];
  if (tekmetricLabelFilter.length > 0) {
    tekmetricWoRows = await sql`
      SELECT * FROM tekmetric_work_orders
      WHERE shop_id = ${shopUuid}
        AND vin IS NOT NULL
        AND status = ANY(${TEKMETRIC_ALLOWED_STATUSES})
        AND label = ANY(${tekmetricLabelFilter})
      ORDER BY synced_at DESC
    `;
  } else {
    tekmetricWoRows = await sql`
      SELECT * FROM tekmetric_work_orders
      WHERE shop_id = ${shopUuid}
        AND vin IS NOT NULL
        AND status = ANY(${TEKMETRIC_ALLOWED_STATUSES})
      ORDER BY synced_at DESC
    `;
  }

  return tekmetricWoRows.map((wo: any) => {
    const vYear = wo.vehicle_year;
    const vMake = wo.vehicle_make || '';
    const vModel = wo.vehicle_model || '';
    const displayVehicle = [vYear, vMake, vModel].filter(Boolean).join(' ').trim();
    const displayStatus = (wo.label && wo.label !== '') ? wo.label : (wo.status || 'Open');
    const mileage = wo.mileage_in || wo.mileage_out || null;
    
    return {
      updatedAt: wo.synced_at || new Date(),
      displayName: wo.customer_name || 'Unknown Customer',
      displayVehicle,
      displayVin: wo.vin,
      displayMiles: mileage,
      displayRo: wo.work_order_number,
      workOrderId: wo.work_order_id,
      dviDone: false,
      source: 'tekmetric' as SMSProvider,
      displayStatus,
      label: wo.label || null,
      labelColor: wo.label_color || null,
      af: {
        status: wo.status || 'Open',
        createdAt: wo.synced_at,
        miles: mileage
      },
      vehicle: {
        year: wo.vehicle_year || null,
        make: wo.vehicle_make || null,
        model: wo.vehicle_model || null,
        engine: wo.vehicle_submodel || null
      }
    };
  });
}

export async function getDashboardData(shopId: string | number): Promise<DashboardDataResult> {
  const shopConfig = await getShopConfig(shopId);
  
  if (!shopConfig) {
    return { rows: [], smsType: null, configuredProviders: [] };
  }

  const allRows: DashboardRow[] = [];
  const configuredProviders: SMSProvider[] = [];
  let primarySmsType: SMSProvider | 'autoflow' | null = null;

  // Fetch from all configured integrations
  if (shopConfig.isAutoFlowConfigured) {
    const autoflowRows = await fetchAutoFlowRows(shopConfig.shopId, shopConfig.id);
    allRows.push(...autoflowRows);
    primarySmsType = 'autoflow';
  }

  if (shopConfig.isProtractorConfigured) {
    const protractorRows = await fetchProtractorRows(shopConfig.shopId, shopConfig.settings);
    allRows.push(...protractorRows);
    configuredProviders.push('protractor');
    if (!primarySmsType) primarySmsType = 'protractor';
  }

  if (shopConfig.isTekmetricConfigured) {
    const tekmetricRows = await fetchTekmetricRows(shopConfig.id, shopConfig.settings);
    allRows.push(...tekmetricRows);
    configuredProviders.push('tekmetric');
    if (!primarySmsType) primarySmsType = 'tekmetric';
  }

  // Dedupe by VIN - keep most recent
  const vinMap = new Map<string, DashboardRow>();
  for (const row of allRows) {
    const existing = vinMap.get(row.displayVin);
    if (!existing || row.updatedAt > existing.updatedAt) {
      vinMap.set(row.displayVin, row);
    }
  }

  return {
    rows: Array.from(vinMap.values()),
    smsType: primarySmsType,
    configuredProviders,
  };
}

export async function getArchivedVehicles(shopId: string | number, search?: string): Promise<DashboardRow[]> {
  const shopConfig = await getShopConfig(shopId);
  if (!shopConfig) return [];

  let archivedVehicles;
  if (search) {
    archivedVehicles = await sql`
      SELECT v.*, c.first_name, c.last_name, c.name as customer_name
      FROM vehicles v
      LEFT JOIN customers c ON v.customer_id = c.id
      WHERE v.shop_id = ${shopConfig.shopId}
        AND (v.status->>'active')::boolean IS NOT TRUE
        AND (
          LOWER(v.vin) LIKE ${`%${search.toLowerCase()}%`}
          OR LOWER(v.make) LIKE ${`%${search.toLowerCase()}%`}
          OR LOWER(v.model) LIKE ${`%${search.toLowerCase()}%`}
          OR LOWER(c.name) LIKE ${`%${search.toLowerCase()}%`}
          OR LOWER(c.first_name) LIKE ${`%${search.toLowerCase()}%`}
          OR LOWER(c.last_name) LIKE ${`%${search.toLowerCase()}%`}
        )
      ORDER BY (v.status->>'lastClosedAt')::timestamp DESC NULLS LAST, v.updated_at DESC
      LIMIT 100
    `;
  } else {
    archivedVehicles = await sql`
      SELECT v.*, c.first_name, c.last_name, c.name as customer_name
      FROM vehicles v
      LEFT JOIN customers c ON v.customer_id = c.id
      WHERE v.shop_id = ${shopConfig.shopId}
        AND (v.status->>'active')::boolean IS NOT TRUE
      ORDER BY (v.status->>'lastClosedAt')::timestamp DESC NULLS LAST, v.updated_at DESC
      LIMIT 100
    `;
  }

  return archivedVehicles.map((v: any) => ({
    updatedAt: v.status?.lastClosedAt || v.updated_at || new Date(),
    displayName: v.customer_name || v.first_name ? 
      `${v.first_name || ''} ${v.last_name || ''}`.trim() : 
      'Unknown Customer',
    displayVehicle: [v.year, v.make, v.model].filter(Boolean).join(' '),
    displayVin: v.vin,
    displayMiles: v.mileage || v.last_mileage || null,
    displayRo: v.tekmetric?.repairOrderNumber || null,
    dviDone: false,
    source: 'autoflow' as const,
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
}
