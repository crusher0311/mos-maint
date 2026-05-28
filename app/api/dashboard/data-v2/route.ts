import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";
import { Db } from "mongodb";
import { NormalizedIngestionService } from "@/lib/integrations/core/normalized-ingestion";

const DRIFT_THRESHOLD_MS = 2 * 60 * 1000;
const DRIFT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * Test seam (Task #520): tests override these to drive the dashboard read
 * against an in-memory Mongo (with a seeded session) and to assert the
 * drift backstop re-normalizes a stale `normalized_work_orders` row when
 * its `protractor_work_orders` snapshot is newer. Production must keep the
 * drift reconcile (and its inline `ingestWorkOrderWithAllEntities`) so the
 * dashboard never serves stale data after a webhook that updated the
 * snapshot but failed to normalize.
 */
export const __deps = {
  getDb,
  cookies,
  createIngestionService: (
    db: Db,
    sourceSystem: "protractor",
    shopId: number,
    enterpriseId: string | undefined,
    options: ConstructorParameters<typeof NormalizedIngestionService>[4],
  ) => new NormalizedIngestionService(db, sourceSystem, shopId, enterpriseId, options),
};

async function reconcileProtractorDrift(db: Db, shopId: number): Promise<void> {
  const lookbackCutoff = new Date(Date.now() - DRIFT_LOOKBACK_MS);
  const recentSnapshots = await db.collection("protractor_work_orders").find(
    {
      shopId: { $in: [String(shopId), Number(shopId)] },
      fetchedAt: { $gte: lookbackCutoff },
      completed: { $ne: true },
    },
    { projection: { workOrderId: 1, workOrderNumber: 1, fetchedAt: 1, rawPayload: 1 } }
  ).toArray();

  if (recentSnapshots.length === 0) return;

  const sourceIds = recentSnapshots
    .map((s: any) => String(s.workOrderId || s.rawPayload?.ID || ""))
    .filter(Boolean);

  const normalizedRows = await db.collection("normalized_work_orders").find(
    {
      shopId,
      'provenance.sourceIds': { $elemMatch: { sourceSystem: 'protractor', sourceId: { $in: sourceIds } } },
    },
    { projection: { updatedAt: 1, 'provenance.sourceIds': 1 } }
  ).toArray();

  const normalizedByWoId = new Map<string, Date>();
  for (const row of normalizedRows) {
    const pids = (row as any).provenance?.sourceIds || [];
    for (const sid of pids) {
      if (sid?.sourceSystem === 'protractor' && sid?.sourceId) {
        normalizedByWoId.set(String(sid.sourceId), row.updatedAt as Date);
      }
    }
  }

  const drifted: any[] = [];
  for (const snap of recentSnapshots) {
    const woId = String(snap.workOrderId || snap.rawPayload?.ID || "");
    if (!woId) continue;
    const snapTs = snap.fetchedAt instanceof Date ? snap.fetchedAt.getTime() : new Date(snap.fetchedAt).getTime();
    const normTs = normalizedByWoId.get(woId);
    const normMs = normTs ? (normTs instanceof Date ? normTs.getTime() : new Date(normTs).getTime()) : 0;
    if (!normMs || snapTs - normMs > DRIFT_THRESHOLD_MS) {
      drifted.push({ snap, lagMs: normMs ? snapTs - normMs : -1, woId });
    }
  }

  if (drifted.length === 0) return;

  const shopDoc = await db.collection("shops").findOne(
    { shopId: { $in: [String(shopId), Number(shopId)] } },
    { projection: { enterpriseId: 1 } }
  );
  const enterpriseId = shopDoc?.enterpriseId as string | undefined;
  const ingestionService = __deps.createIngestionService(
    db,
    'protractor',
    shopId,
    enterpriseId,
    { dualWriteToJobIndex: false, dualWriteToRepairPatterns: true, ingestionVia: 'drift-backstop' }
  );

  for (const { snap, lagMs, woId } of drifted) {
    const payload = snap.rawPayload;
    if (!payload || !payload.ID) continue;
    try {
      const r = await ingestionService.ingestWorkOrderWithAllEntities(payload);
      console.log(
        `[Protractor Drift] shop=${shopId} ro=${snap.workOrderNumber ?? woId} lagMs=${lagMs} action=${r.workOrder.action}`
      );
    } catch (err: any) {
      console.error(`[Protractor Drift] re-normalize failed shop=${shopId} ro=${snap.workOrderNumber ?? woId}:`, err?.message || err);
    }
  }
}

async function batchEstimateMileage(db: Db, shopId: number, rows: any[]) {
  const noMileageVins = rows
    .filter((r) => !r.displayMiles)
    .map((r) => r.displayVin)
    .filter(Boolean);

  if (noMileageVins.length === 0) return;

  try {
    const carfaxDocs = await db.collection("carfax_reports")
      .find({ shopId, vin: { $in: noMileageVins }, ok: true })
      .toArray();

    const fiveYearsAgo = new Date();
    fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5);
    const now = Date.now();

    const estimates = new Map<string, { mileage: number; details: any }>();
    for (const doc of carfaxDocs) {
      if (!Array.isArray(doc.serviceRecords)) continue;
      const valid = doc.serviceRecords
        .filter((r: any) => {
          if (!r.date || r.odometer == null || r.odometer <= 0) return false;
          const d = new Date(r.date);
          return !isNaN(d.getTime()) && d >= fiveYearsAgo;
        })
        .map((r: any) => ({ date: new Date(r.date), odometer: r.odometer as number }))
        .sort((a: any, b: any) => b.date.getTime() - a.date.getTime())
        .slice(0, 3);
      if (valid.length < 2) continue;
      const newest = valid[0];
      const oldest = valid[valid.length - 1];
      const daysBetween = (newest.date.getTime() - oldest.date.getTime()) / (1000 * 60 * 60 * 24);
      if (daysBetween < 30) continue;
      const milesDriven = newest.odometer - oldest.odometer;
      if (milesDriven <= 0) continue;
      const milesPerDay = milesDriven / daysBetween;
      const daysSinceNewest = (now - newest.date.getTime()) / (1000 * 60 * 60 * 24);
      const estimated = Math.round(newest.odometer + milesPerDay * daysSinceNewest);
      estimates.set(doc.vin, {
        mileage: estimated,
        details: {
          confidence: valid.length >= 3 ? "good" : "fair",
          dataPoints: valid.length,
          lastRecordedMileage: newest.odometer,
          lastRecordedDate: newest.date.toISOString().split("T")[0],
          milesPerDay: Math.round(milesPerDay * 10) / 10,
        }
      });
    }

    for (const row of rows) {
      if (!row.displayMiles && row.displayVin) {
        const est = estimates.get(row.displayVin);
        if (est) {
          row.displayMiles = est.mileage;
          row.mileageEstimated = true;
          row.mileageEstimateDetails = est.details;
          if (row.af) row.af.miles = est.mileage;
        }
      }
    }
  } catch (e) {
    console.error("[Dashboard] CARFAX batch estimation error:", e);
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const pageSize = Math.min(100, Math.max(10, parseInt(searchParams.get('pageSize') || '50', 10)));
    const search = searchParams.get('search')?.toLowerCase() || '';
    const showArchived = searchParams.get('archived') === 'true';

    const store = await __deps.cookies();
    const sid = store.get("sid")?.value ?? store.get("session_token")?.value;
    if (!sid) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = await __deps.getDb();
    const now = new Date();

    const sess = await db.collection("sessions").findOne({ token: sid, expiresAt: { $gt: now } });
    if (!sess) {
      return NextResponse.json({ error: "Session expired" }, { status: 401 });
    }

    const user = await db.collection("users").findOne(
      { _id: sess.userId },
      { projection: { email: 1, role: 1, shopId: 1 } }
    );
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const shopId = Number(sess.shopId);
    const shop = await db.collection("shops").findOne({ 
      shopId: { $in: [String(shopId), shopId] } 
    });

    if (showArchived) {
      const archivedQuery: any = {
        shopId,
        status: { $in: ["Invoiced", "Closed", "Void", "Invoice"] }
      };

      if (search) {
        archivedQuery.$or = [
          { vin: { $regex: search, $options: 'i' } },
          { "vehicle.make": { $regex: search, $options: 'i' } },
          { "vehicle.model": { $regex: search, $options: 'i' } },
          { "customer.name": { $regex: search, $options: 'i' } },
        ];
      }

      const totalCount = await db.collection("normalized_work_orders").countDocuments(archivedQuery);
      const archivedWOs = await db.collection("normalized_work_orders")
        .find(archivedQuery)
        .sort({ closedAt: -1, updatedAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray();

      const rows = archivedWOs.map((wo: any) => ({
        updatedAt: wo.closedAt || wo.updatedAt || new Date(),
        displayName: wo.customer?.name || 'Unknown Customer',
        displayVehicle: [wo.vehicle?.year, wo.vehicle?.make, wo.vehicle?.model].filter(Boolean).join(' '),
        displayVin: wo.vin,
        displayMiles: wo.mileageOut || wo.mileageIn || null,
        displayRo: wo.sourceId,
        dviDone: false,
        archived: true,
        source: wo.smsType,
        mileageEstimated: false,
        mileageEstimateDetails: null as any,
        af: {
          status: 'Archived',
          createdAt: wo.closedAt || wo.updatedAt,
          miles: wo.mileageOut || wo.mileageIn || null,
        },
        vehicle: {
          year: wo.vehicle?.year || null,
          make: wo.vehicle?.make || null,
          model: wo.vehicle?.model || null,
          engine: wo.vehicle?.engine || null,
        },
      }));

      await batchEstimateMileage(db, Number(sess.shopId), rows);

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
        user: { email: user.email, role: user.role, shopId: sess.shopId },
        normalized: true
      });
    }

    const shopPrefs = shop?.preferences || {};
    const ACTIVE_STATUSES = [
      "InspectionInProgress", "Unassigned", "WorkAuthorized", "EstimateCompleted",
      "EstimatePresented", "WorkCompleted", "Estimate", "Work-In-Progress", "Complete",
      "CHECKED IN", "IN PROGRESS", "EST"
    ];

    const activeQuery: any = {
      shopId,
      status: { 
        $in: shopPrefs.workflowStages || ACTIVE_STATUSES,
        $nin: ["Invoiced", "Closed", "Void", "Invoice"]
      },
      vin: { $exists: true, $ne: null }
    };

    // Task #517 — Flip default: brand-new ROs without an odometer entry
    // (e.g. RO 3578 at CAR Experts) should still appear on the dashboard
    // so the advisor knows the job exists. The Mileage column renders a
    // "no mileage" indicator when `displayMiles` is null. Shops can still
    // opt INTO the legacy hide-zero-mileage behavior by explicitly
    // setting `preferences.showOnlyWithMileage = true`.
    if (shopPrefs.showOnlyWithMileage === true) {
      activeQuery.$or = [
        { mileageIn: { $gt: 0 } },
        { mileageOut: { $gt: 0 } }
      ];
    }

    // Task #517 — Drift backstop. If `protractor_work_orders` has a
    // snapshot that is newer than its `normalized_work_orders`
    // counterpart by more than 2 minutes, re-normalize on the spot so
    // the dashboard read never serves stale data after a webhook that
    // updated the snapshot but failed to normalize (e.g. server
    // restarted mid fire-and-forget). Cheap: bounded to active
    // protractor snapshots touched in the last 24h.
    if (shop?.protractor?.configured) {
      try {
        await reconcileProtractorDrift(db, shopId);
      } catch (driftErr: any) {
        console.error(`[Protractor Drift] reconcile error shop=${shopId}:`, driftErr?.message || driftErr);
      }
    }

    let workOrders = await db.collection("normalized_work_orders")
      .find(activeQuery)
      .sort({ updatedAt: -1 })
      .toArray();

    if (search) {
      workOrders = workOrders.filter((wo: any) => {
        const searchFields = [
          wo.customer?.name,
          wo.vehicle?.make,
          wo.vehicle?.model,
          wo.vin,
          wo.sourceId?.toString(),
          wo.status
        ].filter(Boolean).map(s => String(s).toLowerCase());
        return searchFields.some(field => field.includes(search));
      });
    }

    const rows = workOrders.map((wo: any) => ({
      updatedAt: wo.updatedAt || new Date(),
      displayName: wo.customer?.name || 'Unknown Customer',
      displayVehicle: [wo.vehicle?.year, wo.vehicle?.make, wo.vehicle?.model].filter(Boolean).join(' '),
      displayVin: wo.vin,
      displayMiles: wo.mileageOut || wo.mileageIn || null,
      displayRo: wo.sourceId,
      workOrderId: wo.sourceId,
      workOrderGuid: wo.sourceId,
      dviDone: wo.hasDvi || false,
      source: wo.smsType,
      displayStatus: wo.label || wo.status,
      mileageEstimated: false,
      mileageEstimateDetails: null as any,
      af: {
        status: wo.status,
        createdAt: wo.createdAt,
        miles: wo.mileageOut || wo.mileageIn || null
      },
      vehicle: {
        year: wo.vehicle?.year || null,
        make: wo.vehicle?.make || null,
        model: wo.vehicle?.model || null,
        engine: wo.vehicle?.engine || null,
      }
    }));

    await batchEstimateMileage(db, Number(sess.shopId), rows);

    rows.sort((a: any, b: any) => {
      const nameA = a.displayName || "";
      const nameB = b.displayName || "";
      return nameA.localeCompare(nameB);
    });

    const totalCount = rows.length;
    const totalPages = Math.ceil(totalCount / pageSize);
    const paginatedRows = rows.slice((page - 1) * pageSize, page * pageSize);

    let smsType = "autoflow";
    if (shop?.protractor?.configured) smsType = "protractor";
    else if (shop?.tekmetric?.configured) smsType = "tekmetric";

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
      user: { email: user.email, role: user.role, shopId: sess.shopId },
      smsType,
      distanceUnit: shop?.preferences?.distanceUnit || "miles",
      normalized: true
    });
    
    response.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    return response;

  } catch (error) {
    console.error("Dashboard data v2 error:", error);
    return NextResponse.json({ error: "Failed to fetch dashboard data" }, { status: 500 });
  }
}
