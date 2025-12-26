// app/dashboard/page.tsx
import { redirect } from "next/navigation";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import DashboardClient from "./DashboardClient";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function DashboardPage() {
  // Session (supports dev auto-login)
  const session = await getSession();
  if (!session) redirect("/login");

  const db = await getDb();
  
  // Use session data directly - supports both real sessions and dev auto-login
  const user = {
    email: session.email,
    role: session.role,
    shopId: session.shopId,
  };

  // Build rows from latest AutoFlow events per VIN (hide closed/appointments)
  const rows = await db.collection("events").aggregate([
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

  // Also fetch Protractor vehicles for shops using Protractor
  const protractorRows = await db.collection("protractor_work_orders").aggregate([
    {
      $match: {
        shopId: { $in: [String(user.shopId), Number(user.shopId)] },
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
        dviDone: { $literal: false },
        source: { $literal: "protractor" },
        af: {
          status: { $ifNull: ["$status", "Open"] },
          createdAt: "$fetchedAt",
          miles: { $ifNull: ["$odometer", { $ifNull: ["$vehicle.odometer", null] }] }
        }
      }
    },
    { $limit: 100 }
  ]).toArray();

  // Merge AutoFlow and Protractor rows, deduplicating by VIN
  const autoflowVins = new Set(rows.map((r: any) => r.displayVin?.toUpperCase()));
  const uniqueProtractorRows = protractorRows.filter(
    (r: any) => r.displayVin && !autoflowVins.has(r.displayVin.toUpperCase())
  );
  
  const allRows = [...rows, ...uniqueProtractorRows].sort((a: any, b: any) => {
    const nameA = a.displayName || "";
    const nameB = b.displayName || "";
    return nameA.localeCompare(nameB);
  });

  const initialData = {
    rows: allRows,
    user: {
      email: user.email,
      role: user.role,
      shopId: user.shopId
    }
  };

  return <DashboardClient initialData={initialData} />;
}