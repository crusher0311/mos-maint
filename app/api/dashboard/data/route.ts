// app/api/dashboard/data/route.ts
import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";
import { getFeatureEntitlements, FeatureKey } from "@/lib/featureResolver";
import { getBatchQuickSpecs } from "@/lib/integrations/dataone-local";
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

    const db = await getDb();
    const sessions = db.collection("sessions");
    const users = db.collection("users");
    const now = new Date();

    const sess = await sessions.findOne({ token: sid, expiresAt: { $gt: now } });
    if (!sess) {
      return NextResponse.json({ error: "Session expired" }, { status: 401 });
    }

    const user = await users.findOne(
      { _id: sess.userId },
      { projection: { email: 1, role: 1, shopId: 1 } }
    );
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Check shop SMS configuration to skip unnecessary queries
    const shopConfig = await db.collection("shops").findOne({ shopId: { $in: [String(user.shopId), Number(user.shopId)] } });
    const isAutoFlowConfigured = !!(shopConfig?.autoflow?.apiKey || shopConfig?.autoflowApiKey);
    const isProtractorPrimary = !!shopConfig?.protractor?.configured;

    // If showing archived vehicles, fetch from vehicles collection directly
    if (showArchived) {
      const archivedQuery: any = {
        shopId: { $in: [String(user.shopId), Number(user.shopId)] },
        "status.active": { $ne: true },
      };

      if (search) {
        archivedQuery.$or = [
          { vin: { $regex: search, $options: 'i' } },
          { make: { $regex: search, $options: 'i' } },
          { model: { $regex: search, $options: 'i' } },
          { "customer.name": { $regex: search, $options: 'i' } },
          { "customer.firstName": { $regex: search, $options: 'i' } },
          { "customer.lastName": { $regex: search, $options: 'i' } },
        ];
      }

      const totalCount = await db.collection("vehicles").countDocuments(archivedQuery);
      const archivedVehicles = await db.collection("vehicles")
        .find(archivedQuery)
        .sort({ "status.lastClosedAt": -1, updatedAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .toArray();

      const rows = archivedVehicles.map((v: any) => ({
        updatedAt: v.status?.lastClosedAt || v.updatedAt || new Date(),
        displayName: v.customer?.name || v.customer?.firstName ? 
          `${v.customer.firstName || ''} ${v.customer.lastName || ''}`.trim() : 
          'Unknown Customer',
        displayVehicle: [v.year, v.make, v.model].filter(Boolean).join(' '),
        displayVin: v.vin,
        displayMiles: v.mileage || v.lastMileage || null,
        displayRo: v.tekmetric?.repairOrderNumber || null,
        dviDone: false,
        archived: true,
        af: {
          status: 'Archived',
          createdAt: v.status?.lastClosedAt || v.updatedAt,
          miles: v.mileage || v.lastMileage || null,
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
          shopId: user.shopId,
        },
      });
    }

    // Build rows from latest AutoFlow events per VIN (only if AutoFlow is configured)
    // Skip this expensive query entirely when AutoFlow is not set up
    let autoflowRows: any[] = [];
    if (isAutoFlowConfigured) {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      autoflowRows = await db.collection("events").aggregate([
      {
        $match: {
          shopId: { $in: [String(user.shopId), Number(user.shopId)] },
          provider: "autoflow",
          receivedAt: { $gte: thirtyDaysAgo }
        }
      },
      // Normalize basic fields we need from events
      {
        $addFields: {
          createdAtDate: { $ifNull: ["$receivedAt", "$createdAt"] },
          statusRaw: {
            $ifNull: [
              "$payload.ticket.status",
              { $ifNull: ["$status", { $ifNull: ["$payload.status", "$type"] }] }
            ]
          },
          vinNorm: {
            $toUpper: {
              $ifNull: [
                "$vehicleVin",
                { $ifNull: ["$vin", "$payload.vehicle.vin"] }
              ]
            }
          },
          // Track active vs close status for smart filtering
          isActiveStatus: {
            $in: ["$payload.ticket.status", ["CHECKED IN", "IN PROGRESS", "EST", "RACK ATTACK", 
              "Build Estimate (Workflow) and Presentation (Advisor)", "Authorized ready for work"]]
          },
          isCloseStatus: { $eq: ["$payload.ticket.status", "Close"] }
        }
      },
      // Require VIN
      { $match: { vinNorm: { $type: "string", $ne: "" } } },
      // Sort by VIN asc, then time desc
      { $sort: { vinNorm: 1, createdAtDate: -1 } },
      {
        $group: {
          _id: "$vinNorm",
          latest: { $first: "$$ROOT" },
          // Track last active and last close timestamps
          lastActive: { $max: { $cond: ["$isActiveStatus", "$createdAtDate", null] } },
          lastClose: { $max: { $cond: ["$isCloseStatus", "$createdAtDate", null] } }
        }
      },
      // Vehicle is active if: no close, OR last active is after last close
      {
        $match: {
          lastActive: { $ne: null },
          $or: [
            { lastClose: null },
            { $expr: { $gt: ["$lastActive", "$lastClose"] } }
          ]
        }
      },
      { $replaceRoot: { newRoot: "$latest" } },
      // Compute display fields
      {
        $addFields: {
          // Name from payload; fallback to nested customer fields if used
          displayName: {
            $let: {
              vars: {
                full: {
                  $trim: {
                    input: {
                      $concat: [
                        { $ifNull: ["$payload.customer.firstname", ""] },
                        {
                          $cond: [
                            {
                              $and: [
                                { $ifNull: ["$payload.customer.firstname", false] },
                                { $ifNull: ["$payload.customer.lastname", false] }
                              ]
                            },
                            " ",
                            ""
                          ]
                        },
                        { $ifNull: ["$payload.customer.lastname", ""] }
                      ]
                    }
                  }
                }
              },
              in: {
                $cond: [
                  { $ne: ["$$full", ""] },
                  "$$full",
                  { $ifNull: ["$payload.customer.name", null] }
                ]
              }
            }
          },
          // Vehicle display from payload
          displayVehicle: {
            $trim: {
              input: {
                $concat: [
                  { $toString: { $ifNull: ["$payload.vehicle.year", ""] } },
                  { $cond: [{ $ifNull: ["$payload.vehicle.year", false] }, " ", ""] },
                  { $ifNull: ["$payload.vehicle.make", ""] },
                  { $cond: [{ $ifNull: ["$payload.vehicle.make", false] }, " ", ""] },
                  { $ifNull: ["$payload.vehicle.model", ""] }
                ]
              }
            }
          },
          displayVin: "$vinNorm",
          displayRo: {
            $ifNull: [
              "$payload.ticket.invoice",
              {
                $ifNull: [
                  "$payload.ticket.id", 
                  {
                    $ifNull: [
                      "$payload.event.invoice",
                      { $ifNull: ["$roNumber", null] }
                    ]
                  }
                ]
              }
            ]
          },
          af: {
            createdAt: "$createdAtDate",
            status: "$statusRaw",
            miles: {
              $ifNull: [
                "$payload.ticket.mileage",
                {
                  $ifNull: [
                    "$payload.mileage",
                    {
                      $ifNull: [
                        "$payload.vehicle.mileage",
                        {
                          $ifNull: [
                            "$payload.vehicle.miles",
                            { $ifNull: ["$payload.vehicle.odometer", null] }
                          ]
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          },
          updatedAt: {
            $ifNull: [
              "$createdAtDate",
              { $ifNull: ["$createdAt", new Date()] }
            ]
          }
        }
      },
      // DVI presence using roNumber (if present)
      {
        $lookup: {
          from: "dvi_results",
          let: { ro: { $toString: "$displayRo" } },
          pipeline: [
            {
              $match: {
                $expr: { 
                  $and: [
                    { $ne: ["$$ro", null] }, 
                    { $ne: ["$$ro", "null"] },
                    { $or: [
                      { $eq: ["$roNumber", "$$ro"] },
                      { $eq: [{ $toString: "$roNumber" }, "$$ro"] }
                    ]}
                  ] 
                }
              }
            },
            { $limit: 1 },
            { $project: { _id: 1 } }
          ],
          as: "dviRes"
        }
      },
      {
        $lookup: {
          from: "dvi",
          let: { ro: { $toString: "$displayRo" } },
          pipeline: [
            {
              $match: {
                $expr: { 
                  $and: [
                    { $ne: ["$$ro", null] }, 
                    { $ne: ["$$ro", "null"] },
                    { $or: [
                      { $eq: ["$roNumber", "$$ro"] },
                      { $eq: [{ $toString: "$roNumber" }, "$$ro"] }
                    ]}
                  ] 
                }
              }
            },
            { $limit: 1 },
            { $project: { _id: 1 } }
          ],
          as: "dviAlt"
        }
      },
      { $addFields: { dviDone: { $gt: [{ $size: { $concatArrays: ["$dviRes", "$dviAlt"] } }, 0] } } },
      // Final projection
      {
        $project: {
          _id: 0,
          updatedAt: 1,
          af: 1,
          displayName: 1,
          displayVehicle: 1,
          displayVin: 1,
          displayMiles: "$af.miles",
          displayRo: 1,
          dviDone: 1,
          vehicle: {
            year: { $ifNull: ["$payload.vehicle.year", null] },
            make: { $ifNull: ["$payload.vehicle.make", null] },
            model: { $ifNull: ["$payload.vehicle.model", null] },
            engine: { $ifNull: ["$payload.vehicle.engine", null] }
          }
        }
      },
      // Sort alphabetically by name for stable order
      { 
        $sort: { 
          displayName: 1  // Alphabetical by customer name
        } 
      },
    ]).toArray();
    } // End of if (!isProtractorPrimary)

    // Fetch shop preferences for workflow stage filtering
    const shopPrefs = await db.collection("shops").findOne(
      { shopId: { $in: [String(user.shopId), Number(user.shopId)] } },
      { projection: { preferences: 1, tekmetric: 1 } }
    );
    const DEFAULT_WORKFLOW_STAGES = [
      "InspectionInProgress", "Unassigned", "WorkAuthorized", "EstimateCompleted",
      "EstimatePresented", "EstimateRejected", "WaitingForParts", "VehicleInBay",
      "VehicleReadyForPickup", "Deferred", "WorkCompleted"
    ];
    const allowedStages = shopPrefs?.preferences?.workflowStages || DEFAULT_WORKFLOW_STAGES;

    // Fetch Protractor work orders directly (they have the odometer)
    // Filter by workflow stage preference - no date limit
    // Fetch Protractor work orders - each work order is a separate row (no VIN grouping)
    // Exclude invoiced/closed work orders - those vehicles have left the shop
    // Terminal stages that indicate vehicle has left the shop (always excluded regardless of preferences)
    const TERMINAL_WORKFLOW_STAGES = ["Invoiced", "Closed", "Void", "ClosedInvoiced", "ClosedVoid"];
    const protractorRows = await db.collection("protractor_work_orders").aggregate([
      {
        $match: {
          shopId: { $in: [String(user.shopId), Number(user.shopId)] },
          vin: { $ne: null, $type: "string" },
          completed: { $ne: true }, // Exclude completed work orders
          status: { $nin: ["Invoiced", "Closed", "Void"] }, // Exclude by status field
          workflowStage: { 
            $in: allowedStages, // Only show allowed workflow stages
            $nin: TERMINAL_WORKFLOW_STAGES // Always exclude terminal stages (vehicle left shop)
          }
        }
      },
      { $sort: { fetchedAt: -1 } },
      {
        $lookup: {
          from: "protractor_vehicles",
          let: { vin: "$vin", shopIdNum: Number(user.shopId), shopIdStr: String(user.shopId) },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $or: [
                      { $eq: ["$shopId", "$$shopIdNum"] },
                      { $eq: ["$shopId", "$$shopIdStr"] }
                    ]},
                    { $eq: ["$vin", "$$vin"] }
                  ]
                }
              }
            },
            { $limit: 1 }
          ],
          as: "vehicle"
        }
      },
      { $unwind: { path: "$vehicle", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          updatedAt: { $ifNull: ["$fetchedAt", new Date()] },
          displayName: {
            $ifNull: [
              "$customer.name",
              { $ifNull: [
                "$vehicle.customer.name",
                { $ifNull: ["$companyName", { $ifNull: ["$contactName", "Unknown Customer"] }] }
              ]}
            ]
          },
          displayVehicle: {
            $concat: [
              { $toString: { $ifNull: ["$vehicle.year", ""] } },
              { $cond: [{ $ifNull: ["$vehicle.year", false] }, " ", ""] },
              { $ifNull: ["$vehicle.make", ""] },
              { $cond: [{ $ifNull: ["$vehicle.make", false] }, " ", ""] },
              { $ifNull: ["$vehicle.model", ""] }
            ]
          },
          displayVin: "$vin",
          displayMiles: {
            $let: {
              vars: {
                rawMiles: { $ifNull: ["$vehicle.mileage", { $ifNull: ["$odometer", { $ifNull: ["$vehicle.odometer", null] }] }] }
              },
              in: { $cond: [{ $gt: ["$$rawMiles", 0] }, "$$rawMiles", null] }
            }
          },
          displayRo: "$workOrderNumber",
          workOrderGuid: "$workOrderGuid",
          dviDone: { $literal: false },
          source: { $literal: "protractor" },
          af: {
            status: { $ifNull: ["$workflowStage", "In Progress"] },
            createdAt: "$fetchedAt",
            miles: {
              $let: {
                vars: {
                  rawMiles: { $ifNull: ["$vehicle.mileage", { $ifNull: ["$odometer", { $ifNull: ["$vehicle.odometer", null] }] }] }
                },
                in: { $cond: [{ $gt: ["$$rawMiles", 0] }, "$$rawMiles", null] }
              }
            }
          },
          vehicle: {
            year: { $ifNull: ["$vehicle.year", null] },
            make: { $ifNull: ["$vehicle.make", null] },
            model: { $ifNull: ["$vehicle.model", null] },
            engine: { $ifNull: ["$vehicle.engine", null] }
          }
        }
      }
    ]).toArray();

    // Fetch Tekmetric work orders from synced collection (like Protractor)
    // Terminal statuses that indicate vehicle has left the shop
    const TEKMETRIC_ALLOWED_STATUSES = ["Estimate", "Estimates", "Work-In-Progress", "Complete", "Completed"];
    
    // Build Tekmetric match criteria with optional label filtering
    const tekmetricMatch: any = {
      shopId: { $in: [String(user.shopId), Number(user.shopId)] },
      vin: { $ne: null, $type: "string" },
      status: { $in: TEKMETRIC_ALLOWED_STATUSES }
    };
    
    // Apply label filter if preferences are set (empty array = show all)
    const tekmetricLabelFilter = shopPrefs?.preferences?.tekmetricLabels || [];
    if (tekmetricLabelFilter.length > 0) {
      tekmetricMatch.label = { $in: tekmetricLabelFilter };
    }
    
    const tekmetricRows = await db.collection("tekmetric_work_orders").aggregate([
      {
        $match: tekmetricMatch
      },
      { $sort: { fetchedAt: -1 } },
      {
        $project: {
          _id: 0,
          updatedAt: { $ifNull: ["$fetchedAt", new Date()] },
          displayName: { $ifNull: ["$customerName", "Unknown Customer"] },
          displayVehicle: {
            $concat: [
              { $toString: { $ifNull: ["$vehicleYear", ""] } },
              { $cond: [{ $ifNull: ["$vehicleYear", false] }, " ", ""] },
              { $ifNull: ["$vehicleMake", ""] },
              { $cond: [{ $ifNull: ["$vehicleMake", false] }, " ", ""] },
              { $ifNull: ["$vehicleModel", ""] }
            ]
          },
          displayVin: "$vin",
          displayMiles: "$odometer",
          displayRo: "$workOrderNumber",
          workOrderId: "$workOrderId",
          dviDone: { $ifNull: ["$dviDone", false] },
          source: { $literal: "tekmetric" },
          displayStatus: { 
            $cond: {
              if: { $and: [{ $ifNull: ["$label", false] }, { $ne: ["$label", ""] }] },
              then: "$label",
              else: { $ifNull: ["$status", "Open"] }
            }
          },
          label: { $ifNull: ["$label", null] },
          labelColor: { $ifNull: ["$labelColor", null] },
          af: {
            status: { $ifNull: ["$status", "Open"] },
            createdAt: "$fetchedAt",
            miles: "$odometer"
          },
          vehicle: {
            year: { $ifNull: ["$vehicleYear", null] },
            make: { $ifNull: ["$vehicleMake", null] },
            model: { $ifNull: ["$vehicleModel", null] },
            engine: { $ifNull: ["$vehicleEngine", null] }
          }
        }
      }
    ]).toArray();

    // Fetch manually-added vehicles for this shop
    const manualVehicles = await db.collection("manual_vehicles")
      .find({ shopId: Number(user.shopId), archived: { $ne: true } })
      .sort({ createdAt: -1 })
      .toArray();

    const manualRows = manualVehicles.map((v: any) => ({
      displayName: v.customerName || "Unknown Customer",
      displayVehicle: [v.vehicleYear, v.vehicleMake, v.vehicleModel].filter(Boolean).join(" ") || "Unknown Vehicle",
      displayVin: v.vin,
      displayRo: v.roNumber || null,
      displayMiles: v.mileage || null,
      dviDone: false,
      source: "manual",
      updatedAt: v.updatedAt || v.createdAt,
      af: {
        status: "Manual",
        createdAt: v.createdAt,
        miles: v.mileage || null,
      },
      vehicle: {
        year: v.vehicleYear || null,
        make: v.vehicleMake || null,
        model: v.vehicleModel || null,
        engine: null,
      },
    }));

    // Combine all rows - each work order shows as its own row (no VIN deduplication)
    const seenWorkOrders = new Set<string>();
    let allRows: any[] = [];
    
    // When Protractor is primary, use Protractor rows (which have workflowStage as status)
    // When only AutoFlow is configured, use AutoFlow rows directly
    // Note: Protractor workflowStage is more granular than AutoFlow status (e.g., "InspectionInProgress" vs "Open")
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

    // Add manual vehicles (only if VIN not already present from SMS sources)
    const smsVins = new Set(allRows.map((r: any) => r.displayVin));
    for (const row of manualRows) {
      if (!smsVins.has(row.displayVin)) {
        allRows.push(row);
      }
    }

    await batchEstimateMileage(db, Number(user.shopId), allRows);

    // Filter to only show vehicles with mileage data (if preference is enabled)
    // This ensures advisors know to enter mileage before the vehicle appears
    const showOnlyWithMileage = shopPrefs?.preferences?.showOnlyWithMileage !== false; // default true
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
    const shop = await db.collection("shops").findOne({ shopId: { $in: [String(user.shopId), Number(user.shopId)] } });
    let smsType = "autoflow"; // default
    if (shop?.protractor?.configured) {
      smsType = "protractor";
    } else if (shop?.tekmetric?.configured) {
      smsType = "tekmetric";
    }
    
    const distanceUnit = shop?.preferences?.distanceUnit || "miles";
    
    // Get enabled features for this shop from featureResolver
    const shopIdNum = typeof user.shopId === 'string' ? parseInt(user.shopId, 10) : user.shopId;
    const entitlements = await getFeatureEntitlements(shopIdNum);
    const enabledFeatures: FeatureKey[] = (Object.keys(entitlements.effectiveFeatures) as FeatureKey[])
      .filter(key => entitlements.effectiveFeatures[key]);

    // Add cache-control headers to prevent browser caching
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
        shopId: user.shopId
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