// app/api/dashboard/data/route.ts
import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";
import { getRepairOrders, getVehicle, getCustomer } from "@/lib/tekmetric";

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

    // Build rows from latest AutoFlow events per VIN (same logic as dashboard page)
    // Limit to last 30 days for performance
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const autoflowRows = await db.collection("events").aggregate([
      {
        $match: {
          shopId: { $in: [String(user.shopId), Number(user.shopId)] },
          provider: "autoflow",
          createdAt: { $gte: thirtyDaysAgo }
        }
      },
      // Normalize basic fields we need from events
      {
        $addFields: {
          createdAtDate: "$createdAt",
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
          }
        }
      },
      // Require VIN
      { $match: { vinNorm: { $type: "string", $ne: "" } } },
      // Sort by VIN asc, then time desc, so first in group is the latest per VIN
      { $sort: { vinNorm: 1, createdAtDate: -1 } },
      {
        $group: {
          _id: "$vinNorm",
          latest: { $first: "$$ROOT" }
        }
      },
      { $replaceRoot: { newRoot: "$latest" } },
      // Hide Closed and Appointment statuses
      { $match: { statusRaw: { $not: /close|appoint/i } } },
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
    const protractorRows = await db.collection("protractor_work_orders").aggregate([
      {
        $match: {
          shopId: { $in: [String(user.shopId), Number(user.shopId)] },
          vin: { $ne: null, $type: "string" },
          completed: { $ne: true }, // Exclude completed work orders
          status: { $nin: ["Invoiced", "Closed", "Void"] }, // Exclude invoiced/closed/void
          workflowStage: { $in: allowedStages } // Only show allowed workflow stages
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
              "$companyName",
              { $ifNull: ["$contactName", "Unknown Customer"] }
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
          displayMiles: { $ifNull: ["$odometer", { $ifNull: ["$vehicle.odometer", null] }] },
          displayRo: "$workOrderNumber",
          workOrderGuid: "$workOrderGuid",
          dviDone: { $literal: false },
          source: { $literal: "protractor" },
          af: {
            status: { $ifNull: ["$workflowStage", "In Progress"] },
            createdAt: "$fetchedAt",
            miles: { $ifNull: ["$odometer", { $ifNull: ["$vehicle.odometer", null] }] }
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

    // Check if Tekmetric is connected before fetching Tekmetric vehicles
    const tekmetricConnected = !!shopPrefs?.tekmetric?.shopId;
    
    // Fetch Tekmetric vehicles - use cache if available, refresh if stale
    let tekmetricRows: any[] = [];
    if (tekmetricConnected && process.env.TEKMETRIC_API_TOKEN) {
      const CACHE_TTL = 2 * 60 * 1000; // 2 minute cache
      const cacheKey = `tekmetric_dashboard_${shopPrefs.tekmetric.shopId}`;
      
      // Check cache first
      const cached = await db.collection("tekmetric_cache").findOne({ 
        key: cacheKey,
        expiresAt: { $gt: new Date() }
      });
      
      if (cached?.rows) {
        console.log(`[Tekmetric] Using cached data (${cached.rows.length} rows)`);
        // Normalize cached rows to ensure vehicle object exists
        tekmetricRows = cached.rows.map((row: any) => ({
          ...row,
          vehicle: row.vehicle || {
            year: null,
            make: null,
            model: null,
            engine: null
          }
        }));
      } else {
        // Fetch fresh data from API
        try {
          const roResponse = await getRepairOrders(shopPrefs.tekmetric.shopId, {
            repairOrderStatusId: [1, 2, 3],
            size: 100,
            sortDirection: 'DESC'
          });
          
          console.log(`[Tekmetric] Fetched ${roResponse.content.length} repair orders from API`);
          
          // Fetch vehicle and customer details for each RO
          for (const ro of roResponse.content) {
            try {
              const vehicle = await getVehicle(ro.vehicleId);
              if (!vehicle.vin) {
                console.log(`[Tekmetric] Skipping RO #${ro.repairOrderNumber} - no VIN`);
                continue;
              }
              
              let customerName = 'Unknown Customer';
              try {
                const customer = await getCustomer(ro.customerId);
                customerName = [customer.firstName, customer.lastName].filter(Boolean).join(' ') || 'Unknown Customer';
              } catch (e) {}
              
              const displayVehicle = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ');
              const statusLabel = ro.repairOrderCustomLabel?.name || ro.repairOrderLabel?.name || ro.repairOrderStatus?.name || 'Open';
              
              tekmetricRows.push({
                updatedAt: ro.updatedDate ? new Date(ro.updatedDate) : new Date(),
                displayName: customerName,
                displayVehicle,
                displayVin: vehicle.vin.toUpperCase(),
                displayMiles: ro.milesIn || ro.milesOut || vehicle.mileageIn || vehicle.mileageOut || null,
                displayRo: ro.repairOrderNumber,
                dviDone: false,
                source: 'tekmetric',
                af: {
                  status: statusLabel,
                  createdAt: ro.createdDate ? new Date(ro.createdDate) : new Date(),
                  miles: ro.milesIn || ro.milesOut || vehicle.mileageIn || vehicle.mileageOut || null
                },
                vehicle: {
                  year: vehicle.year || null,
                  make: vehicle.make || null,
                  model: vehicle.model || null,
                  engine: vehicle.engineSize || null
                }
              });
              
              // Store vehicle in DB for detail page lookups
              await db.collection("vehicles").updateOne(
                { vin: vehicle.vin.toUpperCase() },
                { 
                  $set: {
                    vin: vehicle.vin.toUpperCase(),
                    year: vehicle.year,
                    make: vehicle.make,
                    model: vehicle.model,
                    mileage: ro.milesIn || ro.milesOut || vehicle.mileageIn || vehicle.mileageOut,
                    licensePlate: vehicle.licensePlate,
                    shopId: String(user.shopId),
                    tekmetric: {
                      vehicleId: vehicle.id,
                      customerId: vehicle.customerId,
                      repairOrderNumber: ro.repairOrderNumber,
                      roStatus: ro.repairOrderStatus?.name,
                      lastSynced: new Date()
                    },
                    customer: customerName !== 'Unknown Customer' ? { 
                      name: customerName 
                    } : undefined,
                    updatedAt: new Date()
                  },
                  $setOnInsert: { createdAt: new Date() }
                },
                { upsert: true }
              );
            } catch (e) {
              console.error(`Error fetching vehicle ${ro.vehicleId}:`, e);
            }
          }
          
          // Store in cache
          await db.collection("tekmetric_cache").updateOne(
            { key: cacheKey },
            { 
              $set: { 
                key: cacheKey,
                rows: tekmetricRows, 
                expiresAt: new Date(Date.now() + CACHE_TTL),
                updatedAt: new Date()
              }
            },
            { upsert: true }
          );
        } catch (error) {
          console.error('Error fetching Tekmetric repair orders:', error);
        }
      }
    }

    // Check if Protractor is the primary SMS for this shop
    const shopConfig = await db.collection("shops").findOne({ shopId: { $in: [String(user.shopId), Number(user.shopId)] } });
    const isProtractorPrimary = !!shopConfig?.protractor?.configured;

    // Combine all rows - each work order shows as its own row (no VIN deduplication)
    // Deduplicate by work order number to avoid duplicates from different sources
    // When Protractor is primary, skip AutoFlow to avoid stale/conflicting status data
    const seenWorkOrders = new Set<string>();
    let allRows: any[] = [];
    
    const rowSources = isProtractorPrimary 
      ? [...protractorRows, ...tekmetricRows]  // Skip AutoFlow when Protractor is primary
      : [...autoflowRows, ...protractorRows, ...tekmetricRows];
    
    for (const row of rowSources) {
      const woKey = `${row.source || 'unknown'}-${row.displayRo || row.workOrderGuid || row.displayVin}`;
      if (!seenWorkOrders.has(woKey)) {
        seenWorkOrders.add(woKey);
        allRows.push(row);
      }
    }

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
    const shop = await db.collection("shops").findOne({ shopId: String(user.shopId) });
    let smsType = "autoflow"; // default
    if (shop?.protractor?.configured) {
      smsType = "protractor";
    } else if (shop?.tekmetric?.configured) {
      smsType = "tekmetric";
    }

    return NextResponse.json({
      rows: paginatedRows,
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
      smsType
    });

  } catch (error) {
    console.error("Dashboard data error:", error);
    return NextResponse.json({ error: "Failed to fetch dashboard data" }, { status: 500 });
  }
}