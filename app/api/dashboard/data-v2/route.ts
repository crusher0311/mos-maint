import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";
import { Db } from "mongodb";

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

    const store = await cookies();
    const sid = store.get("sid")?.value ?? store.get("session_token")?.value;
    if (!sid) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = await getDb();
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

    if (shopPrefs.showOnlyWithMileage !== false) {
      activeQuery.$or = [
        { mileageIn: { $gt: 0 } },
        { mileageOut: { $gt: 0 } }
      ];
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
