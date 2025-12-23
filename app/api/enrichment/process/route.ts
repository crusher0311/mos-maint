import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session || !session.shopId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const shopId = parseInt(String(session.shopId), 10);

    const db = await getDb();
    const now = new Date();

    const body = await request.json().catch(() => ({}));
    const batchSize = Math.min(body.batchSize || 5, 20);

    const pendingItems = await db.collection("enrichment_queue")
      .find({ 
        shopId, 
        status: "pending",
        $or: [
          { nextAttemptAt: { $exists: false } },
          { nextAttemptAt: { $lte: now } }
        ]
      })
      .sort({ priority: 1, createdAt: 1 })
      .limit(batchSize)
      .toArray();

    if (pendingItems.length === 0) {
      return NextResponse.json({
        success: true,
        message: "No pending enrichment items",
        processed: 0,
      });
    }

    console.log(`[Enrichment] Processing ${pendingItems.length} items for shop ${shopId}`);

    let processed = 0;
    let oemFetched = 0;
    let carfaxFetched = 0;
    const errors: string[] = [];

    const shop = await db.collection("shops").findOne({ shopId });

    for (const item of pendingItems) {
      try {
        await db.collection("enrichment_queue").updateOne(
          { _id: item._id },
          { $set: { status: "processing", startedAt: now } }
        );

        const vehicle = await db.collection("vehicles").findOne({
          shopId,
          vin: item.vin
        });

        if (!vehicle) {
          await db.collection("enrichment_queue").updateOne(
            { _id: item._id },
            { $set: { status: "failed", error: "Vehicle not found", completedAt: now } }
          );
          continue;
        }

        let oemSuccess = false;
        let carfaxSuccess = false;

        if (!vehicle.oemScheduleFetchedAt && shop?.dataone?.enabled) {
          try {
            const oemResponse = await fetch(
              `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:5000'}/api/dataone/schedule?vin=${item.vin}&shopId=${shopId}`,
              { 
                method: 'GET',
                headers: { 'Cookie': request.headers.get('cookie') || '' }
              }
            );
            
            if (oemResponse.ok) {
              await db.collection("vehicles").updateOne(
                { _id: vehicle._id },
                { $set: { oemScheduleFetchedAt: now } }
              );
              oemSuccess = true;
              oemFetched++;
            }
          } catch (err) {
            console.error(`[Enrichment] OEM fetch failed for ${item.vin}:`, err);
          }
        }

        if (!vehicle.carfaxFetchedAt && shop?.carfax?.enabled) {
          try {
            const carfaxResponse = await fetch(
              `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:5000'}/api/carfax/history?vin=${item.vin}`,
              { 
                method: 'GET',
                headers: { 'Cookie': request.headers.get('cookie') || '' }
              }
            );
            
            if (carfaxResponse.ok) {
              await db.collection("vehicles").updateOne(
                { _id: vehicle._id },
                { $set: { carfaxFetchedAt: now } }
              );
              carfaxSuccess = true;
              carfaxFetched++;
            }
          } catch (err) {
            console.error(`[Enrichment] CARFAX fetch failed for ${item.vin}:`, err);
          }
        }

        await db.collection("enrichment_queue").updateOne(
          { _id: item._id },
          { 
            $set: { 
              status: "completed",
              completedAt: now,
              oemFetched: oemSuccess,
              carfaxFetched: carfaxSuccess,
            } 
          }
        );

        processed++;

      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        errors.push(`${item.vin}: ${errMsg}`);
        
        const attempts = (item.attempts || 0) + 1;
        const nextAttemptAt = new Date(now.getTime() + Math.min(attempts * 60000, 3600000));
        
        await db.collection("enrichment_queue").updateOne(
          { _id: item._id },
          { 
            $set: { 
              status: attempts >= 3 ? "failed" : "pending",
              error: errMsg,
              attempts,
              nextAttemptAt,
              lastAttemptAt: now,
            } 
          }
        );
      }
    }

    console.log(`[Enrichment] Processed ${processed} items. OEM: ${oemFetched}, CARFAX: ${carfaxFetched}`);

    return NextResponse.json({
      success: true,
      processed,
      oemFetched,
      carfaxFetched,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error("[Enrichment] Error:", error);
    return NextResponse.json({ 
      error: error instanceof Error ? error.message : "Processing failed" 
    }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session || !session.shopId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const shopId = parseInt(String(session.shopId), 10);

    const db = await getDb();

    const pending = await db.collection("enrichment_queue").countDocuments({ shopId, status: "pending" });
    const processing = await db.collection("enrichment_queue").countDocuments({ shopId, status: "processing" });
    const completed = await db.collection("enrichment_queue").countDocuments({ shopId, status: "completed" });
    const failed = await db.collection("enrichment_queue").countDocuments({ shopId, status: "failed" });

    return NextResponse.json({
      pending,
      processing,
      completed,
      failed,
      total: pending + processing + completed + failed,
    });
  } catch (error) {
    console.error("[Enrichment GET] Error:", error);
    return NextResponse.json({ error: "Failed to fetch status" }, { status: 500 });
  }
}
