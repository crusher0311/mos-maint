// app/api/dashboard/data/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";

export async function GET() {
  try {
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
    const autoflowRows = await db.collection("events").aggregate([
      {
        $match: {
          $and: [
            { $or: [{ shopId: String(user.shopId) }, { shopId: Number(user.shopId) }] },
            { provider: "autoflow" }
          ]
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
      // Limit to a reasonable count
      { $limit: 100 }
    ]).toArray();

    // Also fetch Protractor work orders with active status
    const protractorRows = await db.collection("protractor_work_orders").aggregate([
      {
        $match: {
          $or: [
            { shopId: Number(user.shopId) },
            { shopId: String(user.shopId) }
          ]
        }
      },
      {
        $lookup: {
          from: "protractor_vehicles",
          let: { serviceItemId: "$serviceItemId", vin: "$vin" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $or: [
                    { $eq: ["$protractorId", "$$serviceItemId"] },
                    { $eq: [{ $toUpper: "$vin" }, { $toUpper: "$$vin" }] }
                  ]
                }
              }
            },
            { $limit: 1 }
          ],
          as: "vehicleData"
        }
      },
      { $unwind: { path: "$vehicleData", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          updatedAt: { $ifNull: ["$fetchedAt", new Date()] },
          displayName: { $ifNull: ["$contactName", "Unknown Customer"] },
          displayVehicle: {
            $concat: [
              { $toString: { $ifNull: ["$vehicleData.year", ""] } },
              { $cond: [{ $ifNull: ["$vehicleData.year", false] }, " ", ""] },
              { $ifNull: ["$vehicleData.make", ""] },
              { $cond: [{ $ifNull: ["$vehicleData.make", false] }, " ", ""] },
              { $ifNull: ["$vehicleData.model", ""] }
            ]
          },
          displayVin: { $toUpper: { $ifNull: ["$vehicleData.vin", "$vin"] } },
          displayMiles: { $ifNull: ["$odometer", "$vehicleData.odometer"] },
          displayRo: "$workOrderNumber",
          dviDone: { $literal: false },
          source: { $literal: "protractor" },
          af: {
            status: "$status",
            createdAt: "$fetchedAt",
            miles: { $ifNull: ["$odometer", "$vehicleData.odometer"] }
          }
        }
      },
      { $match: { displayVin: { $type: "string", $ne: "" } } },
      { $limit: 100 }
    ]).toArray();

    // Merge and deduplicate by VIN (AutoFlow takes priority)
    const autoflowVins = new Set(autoflowRows.map((r: any) => r.displayVin?.toUpperCase()));
    const uniqueProtractorRows = protractorRows.filter(
      (r: any) => r.displayVin && !autoflowVins.has(r.displayVin.toUpperCase())
    );

    const rows = [...autoflowRows, ...uniqueProtractorRows].sort((a: any, b: any) => {
      const nameA = a.displayName || "";
      const nameB = b.displayName || "";
      return nameA.localeCompare(nameB);
    });

    return NextResponse.json({
      rows,
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