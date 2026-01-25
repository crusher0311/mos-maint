// app/api/admin/shops/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    // Check admin authorization
    const session = await getSession();
    if (!session || session.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const db = await getDb();
    
    // Get search and pagination params
    const { searchParams } = new URL(req.url);
    const search = searchParams.get("search") || "";
    const page = parseInt(searchParams.get("page") || "1");
    const limit = parseInt(searchParams.get("limit") || "20");
    const skip = (page - 1) * limit;

    // Build query
    let query: any = {};
    if (search) {
      query = {
        $or: [
          { name: { $regex: search, $options: "i" } },
          { shopId: { $regex: search, $options: "i" } }
        ]
      };
    }

    // Get shops with pagination and stats in single aggregation
    const [shopsResult, total] = await Promise.all([
      db.collection("shops").aggregate([
        { $match: query },
        { $sort: { createdAt: -1 } },
        { $skip: skip },
        { $limit: limit },
        {
          $lookup: {
            from: "users",
            let: { shopId: "$shopId" },
            pipeline: [
              { $match: { $expr: { $eq: ["$shopId", "$$shopId"] } } },
              { $count: "count" }
            ],
            as: "userStats"
          }
        },
        {
          $lookup: {
            from: "customers",
            let: { shopId: "$shopId" },
            pipeline: [
              { $match: { $expr: { $eq: ["$shopId", "$$shopId"] } } },
              { $count: "count" }
            ],
            as: "customerStats"
          }
        },
        {
          $lookup: {
            from: "vehicles",
            let: { shopId: "$shopId" },
            pipeline: [
              { $match: { $expr: { $eq: ["$shopId", "$$shopId"] } } },
              { $count: "count" }
            ],
            as: "vehicleStats"
          }
        },
        {
          $lookup: {
            from: "events",
            let: { shopId: "$shopId" },
            pipeline: [
              { $match: { $expr: { $eq: ["$shopId", "$$shopId"] } } },
              { $sort: { receivedAt: -1 } },
              { $limit: 1 },
              { $project: { receivedAt: 1 } }
            ],
            as: "lastEvent"
          }
        },
        {
          $addFields: {
            stats: {
              users: { $ifNull: [{ $arrayElemAt: ["$userStats.count", 0] }, 0] },
              customers: { $ifNull: [{ $arrayElemAt: ["$customerStats.count", 0] }, 0] },
              vehicles: { $ifNull: [{ $arrayElemAt: ["$vehicleStats.count", 0] }, 0] },
              events: 0,
              lastActivity: { $arrayElemAt: ["$lastEvent.receivedAt", 0] }
            }
          }
        },
        {
          $project: {
            userStats: 0,
            customerStats: 0,
            vehicleStats: 0,
            lastEvent: 0
          }
        }
      ]).toArray(),
      db.collection("shops").countDocuments(query)
    ]);

    return NextResponse.json({
      shops: shopsResult,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });

  } catch (error) {
    console.error("Admin shops API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    // Check admin authorization
    const session = await getSession();
    if (!session || session.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { name, contactEmail, autoflowConfig } = body;

    if (!name) {
      return NextResponse.json({ error: "Shop name is required" }, { status: 400 });
    }

    const db = await getDb();
    
    // Get next shop ID
    const counter = await db.collection("counters").findOneAndUpdate(
      { _id: "shopId" },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: "after" }
    );

    const shopId = counter.seq || 10001;

    // Create shop document
    const shopDoc = {
      shopId,
      name: name.trim(),
      contactEmail: contactEmail?.trim() || null,
      webhookToken: require("crypto").randomBytes(12).toString("hex"),
      createdAt: new Date(),
      updatedAt: new Date(),
      status: "active",
      ...(autoflowConfig && {
        credentials: {
          autoflow: autoflowConfig
        }
      })
    };

    const result = await db.collection("shops").insertOne(shopDoc);

    return NextResponse.json({
      shop: {
        _id: result.insertedId,
        ...shopDoc
      }
    }, { status: 201 });

  } catch (error) {
    console.error("Admin create shop error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}