// app/api/dashboard/recent/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";

export const dynamic = "force-dynamic";

type Row = {
  updatedAt?: Date | string | null;
  af?: { status?: string; createdAt?: Date | string; miles?: number | null } | null;
  displayName: string | null;
  displayVehicle: string | null;
  displayVin: string | null;
  displayMiles: number | null;
  displayRo: string | null;
  dviDone: boolean;
};

export async function GET() {
  try {
    const store = await cookies();
    const sid = store.get("sid")?.value ?? store.get("session_token")?.value;
    if (!sid) return NextResponse.json({ items: [] }, { status: 401 });

    const db = await getDb();
    const sessions = db.collection("sessions");
    const users = db.collection("users");
    const now = new Date();

    const sess = await sessions.findOne({ token: sid, expiresAt: { $gt: now } });
    if (!sess) return NextResponse.json({ items: [] }, { status: 401 });

    const user = await users.findOne(
      { _id: sess.userId },
      { projection: { email: 1, role: 1, shopId: 1 } }
    );
    if (!user) return NextResponse.json({ items: [] }, { status: 401 });

    const pipeline: any[] = [
      {
        $match: {
          $and: [
            { $or: [{ shopId: String(user.shopId) }, { shopId: Number(user.shopId) }] },
            { provider: "autoflow" },
          ],
        },
      },
      {
        $addFields: {
          createdAtDate: {
            $cond: [
              { $eq: [{ $type: "$createdAt" }, "date"] },
              "$createdAt",
              {
                $dateFromString: {
                  dateString: { $toString: "$createdAt" },
                  onError: null,
                  onNull: null,
                },
              },
            ],
          },
          statusRaw: {
            $ifNull: [
              "$payload.ticket.status",
              { $ifNull: ["$status", { $ifNull: ["$payload.status", "$type"] }] },
            ],
          },
          vinNorm: {
            $toUpper: {
              $ifNull: ["$vehicleVin", { $ifNull: ["$vin", "$payload.vehicle.vin"] }],
            },
          },
        },
      },
      { $match: { vinNorm: { $type: "string", $ne: "" } } },
      { $sort: { vinNorm: 1, createdAtDate: -1 } },
      {
        $group: {
          _id: "$vinNorm",
          latest: { $first: "$$ROOT" },
        },
      },
      { $replaceRoot: { newRoot: "$latest" } },
      { $match: { statusRaw: { $not: /close|appoint/i } } },
      {
        $addFields: {
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
                                { $ifNull: ["$payload.customer.lastname", false] },
                              ],
                            },
                            " ",
                            "",
                          ],
                        },
                        { $ifNull: ["$payload.customer.lastname", ""] },
                      ],
                    },
                  },
                },
              },
              in: {
                $cond: [
                  { $ne: ["$$full", ""] },
                  "$$full",
                  { $ifNull: ["$payload.customer.name", null] },
                ],
              },
            },
          },
          displayVehicle: {
            $trim: {
              input: {
                $concat: [
                  { $toString: { $ifNull: ["$payload.vehicle.year", ""] } },
                  { $cond: [{ $ifNull: ["$payload.vehicle.year", false] }, " ", ""] },
                  { $ifNull: ["$payload.vehicle.make", "" ] },
                  { $cond: [{ $ifNull: ["$payload.vehicle.make", false] }, " ", ""] },
                  { $ifNull: ["$payload.vehicle.model", "" ] },
                ],
              },
            },
          },
          displayVin: "$vinNorm",
          displayRo: { $ifNull: ["$payload.ticket.roNumber", null] },
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
                            { $ifNull: ["$payload.vehicle.odometer", null] },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
          updatedAt: "$createdAtDate",
        },
      },
      {
        $lookup: {
          from: "dvi_results",
          let: { ro: "$displayRo" },
          pipeline: [
            {
              $match: {
                $expr: { $and: [{ $ne: ["$$ro", null] }, { $eq: ["$roNumber", "$$ro"] }] },
              },
            },
            { $limit: 1 },
            { $project: { _id: 1 } },
          ],
          as: "dviRes",
        },
      },
      {
        $lookup: {
          from: "dvi",
          let: { ro: "$displayRo" },
          pipeline: [
            {
              $match: {
                $expr: { $and: [{ $ne: ["$$ro", null] }, { $eq: ["$roNumber", "$$ro"] }] },
              },
            },
            { $limit: 1 },
            { $project: { _id: 1 } },
          ],
          as: "dviAlt",
        },
      },
      { $addFields: { dviDone: { $gt: [{ $size: { $concatArrays: ["$dviRes", "$dviAlt"] } }, 0] } } },
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
        },
      },
      { $sort: { updatedAt: -1 } },
      { $limit: 100 },
    ];

    const items = await db.collection("events").aggregate<Row>(pipeline).toArray();
    return NextResponse.json({ items });
  } catch (err: any) {
    console.error("dashboard/recent error:", err);
    return NextResponse.json({ items: [], error: err?.message ?? "error" }, { status: 500 });
  }
}
