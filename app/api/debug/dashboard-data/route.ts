// app/api/debug/dashboard-data/route.ts
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getDb } from "@/lib/mongo";

export async function GET() {
  try {
    const store = await cookies();
    const sid = store.get("sid")?.value ?? store.get("session_token")?.value;
    if (!sid) {
      return NextResponse.json({ error: "No session" }, { status: 401 });
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

    // Get a sample event to see structure
    const sampleEvent = await db.collection("events").findOne({
      $and: [
        { $or: [{ shopId: String(user.shopId) }, { shopId: Number(user.shopId) }] },
        { provider: "autoflow" }
      ]
    });

    // Check for RO numbers in different places
    const eventWithRO = await db.collection("events").findOne({
      $and: [
        { $or: [{ shopId: String(user.shopId) }, { shopId: Number(user.shopId) }] },
        { provider: "autoflow" },
        {
          $or: [
            { "payload.ticket.roNumber": { $exists: true, $ne: null } },
            { "payload.roNumber": { $exists: true, $ne: null } },
            { "roNumber": { $exists: true, $ne: null } }
          ]
        }
      ]
    });

    // Get processed rows (first 3)
    const rows = await db.collection("events").aggregate([
      {
        $match: {
          $and: [
            { $or: [{ shopId: String(user.shopId) }, { shopId: Number(user.shopId) }] },
            { provider: "autoflow" }
          ]
        }
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
                  onNull: null
                }
              }
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
      { $match: { vinNorm: { $type: "string", $ne: "" } } },
      { $sort: { vinNorm: 1, createdAtDate: -1 } },
      {
        $group: {
          _id: "$vinNorm",
          latest: { $first: "$$ROOT" }
        }
      },
      { $replaceRoot: { newRoot: "$latest" } },
      {
        $addFields: {
          displayRo: {
            $ifNull: [
              "$payload.ticket.roNumber",
              {
                $ifNull: [
                  "$payload.roNumber", 
                  { $ifNull: ["$roNumber", null] }
                ]
              }
            ]
          },
          updatedAt: "$createdAtDate"
        }
      },
      { $limit: 3 }
    ]).toArray();

    return NextResponse.json({
      userShopId: user.shopId,
      sampleEvent: sampleEvent ? {
        _id: sampleEvent._id,
        provider: sampleEvent.provider,
        createdAt: sampleEvent.createdAt,
        shopId: sampleEvent.shopId,
        payload: {
          hasTicket: !!sampleEvent.payload?.ticket,
          ticketFields: sampleEvent.payload?.ticket ? Object.keys(sampleEvent.payload.ticket) : [],
          roNumber: sampleEvent.payload?.ticket?.roNumber,
          payloadRoNumber: sampleEvent.payload?.roNumber,
          directRoNumber: sampleEvent.roNumber
        }
      } : null,
      eventWithRO: eventWithRO ? {
        _id: eventWithRO._id,
        roNumber: eventWithRO.payload?.ticket?.roNumber,
        payloadRO: eventWithRO.payload?.roNumber,
        directRO: eventWithRO.roNumber
      } : null,
      processedRows: rows.map(row => ({
        vin: row.vinNorm,
        displayRo: row.displayRo,
        updatedAt: row.updatedAt,
        createdAt: row.createdAt,
        createdAtDate: row.createdAtDate
      })),
      totalEvents: await db.collection("events").countDocuments({
        $and: [
          { $or: [{ shopId: String(user.shopId) }, { shopId: Number(user.shopId) }] },
          { provider: "autoflow" }
        ]
      })
    });

  } catch (error) {
    console.error("Debug error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}