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

    // Get shops with pagination
    const [shops, total] = await Promise.all([
      db.collection("shops")
        .find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      db.collection("shops").countDocuments(query)
    ]);

    // Get stats for each shop
    const shopsWithStats = await Promise.all(
      shops.map(async (shop) => {
        const [userCount, customerCount, vehicleCount, eventCount, lastActivity] = await Promise.all([
          db.collection("users").countDocuments({ shopId: shop.shopId }),
          db.collection("customers").countDocuments({ shopId: shop.shopId }),
          db.collection("vehicles").countDocuments({ shopId: shop.shopId }),
          db.collection("events").countDocuments({ shopId: shop.shopId }),
          db.collection("events")
            .findOne(
              { shopId: shop.shopId },
              { sort: { receivedAt: -1 } }
            )
        ]);

        return {
          ...shop,
          stats: {
            users: userCount,
            customers: customerCount,
            vehicles: vehicleCount,
            events: eventCount,
            lastActivity: lastActivity?.receivedAt || null
          }
        };
      })
    );

    return NextResponse.json({
      shops: shopsWithStats,
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