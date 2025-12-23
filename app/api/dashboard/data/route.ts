// app/api/dashboard/data/route.ts
import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";

export async function GET(request: NextRequest) {
  try {
    // Parse pagination params
    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const pageSize = Math.min(100, Math.max(10, parseInt(searchParams.get('pageSize') || '50', 10)));
    const search = searchParams.get('search')?.toLowerCase() || '';
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
          dviDone: 1
        }
      },
      // Sort alphabetically by name for stable order
      { 
        $sort: { 
          displayName: 1  // Alphabetical by customer name
        } 
      },
    ]).toArray();

    // Fetch Protractor work orders directly (they have the odometer)
    const protractorRows = await db.collection("protractor_work_orders").aggregate([
      {
        $match: {
          shopId: Number(user.shopId),
          vin: { $ne: null, $type: "string" }
        }
      },
      { $sort: { fetchedAt: -1 } },
      {
        $group: {
          _id: "$vin",
          latest: { $first: "$$ROOT" }
        }
      },
      { $replaceRoot: { newRoot: "$latest" } },
      {
        $lookup: {
          from: "protractor_vehicles",
          let: { vin: "$vin" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$shopId", Number(user.shopId)] },
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
          dviDone: { $literal: false },
          source: { $literal: "protractor" },
          af: {
            status: { $ifNull: ["$status", "Open"] },
            createdAt: "$fetchedAt",
            miles: { $ifNull: ["$odometer", { $ifNull: ["$vehicle.odometer", null] }] }
          }
        }
      }
    ]).toArray();

    // Check if Tekmetric is connected before fetching Tekmetric vehicles
    const shop = await db.collection("shops").findOne({});
    const tekmetricConnected = !!shop?.tekmetric?.shopId;
    
    // Fetch Tekmetric vehicles only if Tekmetric is connected
    let tekmetricRows: any[] = [];
    if (tekmetricConnected) {
      tekmetricRows = await db.collection("vehicles").aggregate([
        {
          $match: {
            "tekmetric.shopId": { $exists: true },
            "tekmetric.repairOrderNumber": { $exists: true },
            vin: { $ne: null, $type: "string" }
          }
        },
        { $sort: { updatedAt: -1 } },
        {
          $project: {
            _id: 0,
            updatedAt: { $ifNull: ["$updatedAt", new Date()] },
            displayName: {
              $cond: [
                { $and: [{ $ifNull: ["$customer.firstName", false] }, { $ifNull: ["$customer.lastName", false] }] },
                { $concat: ["$customer.firstName", " ", "$customer.lastName"] },
                { $ifNull: ["$customer.firstName", { $ifNull: ["$customer.lastName", "Unknown Customer"] }] }
              ]
            },
            displayVehicle: {
              $concat: [
                { $toString: { $ifNull: ["$year", ""] } },
                { $cond: [{ $ifNull: ["$year", false] }, " ", ""] },
                { $ifNull: ["$make", ""] },
                { $cond: [{ $ifNull: ["$make", false] }, " ", ""] },
                { $ifNull: ["$model", ""] }
              ]
            },
            displayVin: { $toUpper: "$vin" },
            displayMiles: "$mileage",
            displayRo: "$tekmetric.repairOrderNumber",
            dviDone: { $literal: false },
            source: { $literal: "tekmetric" },
            af: {
              status: { $ifNull: ["$tekmetric.roLabel", { $ifNull: ["$tekmetric.roStatus", "Open"] }] },
              createdAt: "$tekmetric.lastSynced",
              miles: "$mileage"
            }
          }
        }
      ]).toArray();
    }

    // Merge and deduplicate by VIN (AutoFlow takes priority, then Protractor, then Tekmetric)
    const autoflowVins = new Set(autoflowRows.map((r: any) => r.displayVin?.toUpperCase()));
    const uniqueProtractorRows = protractorRows.filter(
      (r: any) => r.displayVin && !autoflowVins.has(r.displayVin.toUpperCase())
    );
    
    const existingVins = new Set([
      ...autoflowRows.map((r: any) => r.displayVin?.toUpperCase()),
      ...uniqueProtractorRows.map((r: any) => r.displayVin?.toUpperCase())
    ]);
    const uniqueTekmetricRows = tekmetricRows.filter(
      (r: any) => r.displayVin && !existingVins.has(r.displayVin.toUpperCase())
    );

    // Combine all rows
    let allRows = [...autoflowRows, ...uniqueProtractorRows, ...uniqueTekmetricRows];

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
      }
    });

  } catch (error) {
    console.error("Dashboard data error:", error);
    return NextResponse.json({ error: "Failed to fetch dashboard data" }, { status: 500 });
  }
}