import { NextRequest, NextResponse } from "next/server";
import sql from "@/lib/db/postgres";
import { getSession } from "@/lib/auth";

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session || !session.shopId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const shopId = String(session.shopId);

    const now = new Date();

    const body = await request.json().catch(() => ({}));
    const batchSize = Math.min(body.batchSize || 5, 20);

    const pendingItems = await sql`
      SELECT * FROM enrichment_queue
      WHERE shop_id = ${shopId} 
        AND status = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
      ORDER BY priority ASC, created_at ASC
      LIMIT ${batchSize}
    `;

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

    const shopRows = await sql`SELECT settings FROM shops WHERE shop_id = ${shopId} LIMIT 1`;
    const shop = shopRows[0];
    const settings = shop?.settings || {};

    for (const item of pendingItems) {
      try {
        await sql`
          UPDATE enrichment_queue SET status = 'processing', started_at = ${now}
          WHERE id = ${item.id}
        `;

        const vehicleRows = await sql`
          SELECT * FROM vehicles WHERE shop_id = ${shopId} AND vin = ${item.vin} LIMIT 1
        `;
        const vehicle = vehicleRows[0];

        if (!vehicle) {
          await sql`
            UPDATE enrichment_queue SET 
              status = 'failed', 
              error = 'Vehicle not found', 
              completed_at = ${now}
            WHERE id = ${item.id}
          `;
          continue;
        }

        let oemSuccess = false;
        let carfaxSuccess = false;

        if (!vehicle.oem_schedule_fetched_at && settings.dataone?.enabled) {
          try {
            const oemResponse = await fetch(
              `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:5000'}/api/dataone/schedule?vin=${item.vin}&shopId=${shopId}`,
              { 
                method: 'GET',
                headers: { 'Cookie': request.headers.get('cookie') || '' }
              }
            );
            
            if (oemResponse.ok) {
              await sql`
                UPDATE vehicles SET oem_schedule_fetched_at = ${now}
                WHERE id = ${vehicle.id}
              `;
              oemSuccess = true;
              oemFetched++;
            }
          } catch (err) {
            console.error(`[Enrichment] OEM fetch failed for ${item.vin}:`, err);
          }
        }

        if (!vehicle.carfax_fetched_at && settings.carfax?.enabled) {
          try {
            const carfaxResponse = await fetch(
              `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:5000'}/api/carfax/history?vin=${item.vin}`,
              { 
                method: 'GET',
                headers: { 'Cookie': request.headers.get('cookie') || '' }
              }
            );
            
            if (carfaxResponse.ok) {
              await sql`
                UPDATE vehicles SET carfax_fetched_at = ${now}
                WHERE id = ${vehicle.id}
              `;
              carfaxSuccess = true;
              carfaxFetched++;
            }
          } catch (err) {
            console.error(`[Enrichment] CARFAX fetch failed for ${item.vin}:`, err);
          }
        }

        await sql`
          UPDATE enrichment_queue SET 
            status = 'completed',
            completed_at = ${now},
            oem_fetched = ${oemSuccess},
            carfax_fetched = ${carfaxSuccess}
          WHERE id = ${item.id}
        `;

        processed++;

      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        errors.push(`${item.vin}: ${errMsg}`);
        
        const attempts = (item.attempts || 0) + 1;
        const nextAttemptAt = new Date(now.getTime() + Math.min(attempts * 60000, 3600000));
        
        await sql`
          UPDATE enrichment_queue SET 
            status = ${attempts >= 3 ? 'failed' : 'pending'},
            error = ${errMsg},
            attempts = ${attempts},
            next_attempt_at = ${nextAttemptAt},
            last_attempt_at = ${now}
          WHERE id = ${item.id}
        `;
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
    const shopId = String(session.shopId);

    const countRows = await sql`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'pending')::int as pending,
        COUNT(*) FILTER (WHERE status = 'processing')::int as processing,
        COUNT(*) FILTER (WHERE status = 'completed')::int as completed,
        COUNT(*) FILTER (WHERE status = 'failed')::int as failed,
        COUNT(*)::int as total
      FROM enrichment_queue 
      WHERE shop_id = ${shopId}
    `;
    const counts = countRows[0];

    return NextResponse.json({
      pending: counts.pending,
      processing: counts.processing,
      completed: counts.completed,
      failed: counts.failed,
      total: counts.total,
    });
  } catch (error) {
    console.error("[Enrichment GET] Error:", error);
    return NextResponse.json({ error: "Failed to fetch status" }, { status: 500 });
  }
}
