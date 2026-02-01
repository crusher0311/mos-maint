import { NextRequest, NextResponse } from "next/server";
import sql from "@/lib/db/postgres";

const VALID_TERMINAL_STATUSES = ["INVOICED", "INVOICE", "CLOSED", "VOID"];
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX = 30;

async function checkRateLimit(connectionId: string): Promise<{ allowed: boolean; remaining: number }> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - RATE_LIMIT_WINDOW_MS);
  
  const result = await sql`
    SELECT COUNT(*) as count FROM protractor_callback_events
    WHERE connection_id = ${connectionId} AND received_at >= ${windowStart}
  `;
  const recentCount = Number(result[0]?.count || 0);
  
  if (recentCount >= RATE_LIMIT_MAX) {
    return { allowed: false, remaining: 0 };
  }
  
  return { allowed: true, remaining: RATE_LIMIT_MAX - recentCount };
}

export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get("content-type") || "";
    console.log("[Protractor Callback] Content-Type:", contentType);
    
    let payload: Record<string, unknown> = {};
    
    if (contentType.includes("application/json")) {
      payload = await request.json();
    } else if (contentType.includes("application/x-www-form-urlencoded")) {
      const formData = await request.formData();
      formData.forEach((value, key) => {
        payload[key] = value;
      });
    } else if (contentType.includes("text/")) {
      const text = await request.text();
      console.log("[Protractor Callback] Raw text:", text.slice(0, 500));
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { rawText: text };
      }
    } else {
      const text = await request.text();
      console.log("[Protractor Callback] Raw body:", text.slice(0, 500));
      try {
        payload = JSON.parse(text);
      } catch {
        const params = new URLSearchParams(text);
        params.forEach((value, key) => {
          payload[key] = value;
        });
      }
    }
    
    const url = new URL(request.url);
    url.searchParams.forEach((value, key) => {
      if (!payload[key]) {
        payload[key] = value;
      }
    });
    
    console.log("[Protractor Callback] Received:", JSON.stringify(payload).slice(0, 500));

    const workOrderId = (payload.WorkOrderGuid || payload.workOrderGuid || payload.ID || payload.id) as string | undefined;
    const status = (payload.Status || payload.status || payload.WorkflowStage || payload.workflowStage) as string | undefined;
    const connectionId = (payload.ConnectionId || payload.connectionId) as string | undefined;

    if (!connectionId) {
      console.log("[Protractor Callback] Rejected: No connectionId in payload");
      return NextResponse.json({ ok: false, error: "Missing connectionId" }, { status: 400 });
    }

    const rateCheck = await checkRateLimit(connectionId);
    if (!rateCheck.allowed) {
      console.warn(`[Protractor Callback] Rate limited: connectionId ${connectionId}`);
      return NextResponse.json({ ok: false, error: "Rate limit exceeded" }, { status: 429 });
    }

    const shopResult = await sql`
      SELECT id, shop_id, name FROM shops
      WHERE protractor_config->>'connectionId' = ${connectionId}
      LIMIT 1
    `;

    if (shopResult.length === 0) {
      console.log(`[Protractor Callback] Rejected: Unknown connectionId ${connectionId}`);
      return NextResponse.json({ ok: false, error: "Unknown connectionId" }, { status: 403 });
    }
    
    const shop = shopResult[0];

    if (!workOrderId) {
      console.log("[Protractor Callback] No work order ID in payload");
      return NextResponse.json({ ok: true, message: "No work order ID" });
    }

    const existingEvent = await sql`
      SELECT id FROM protractor_callback_events
      WHERE work_order_id = ${workOrderId} 
        AND status = ${status || null}
        AND processed = TRUE
        AND processed_at >= ${new Date(Date.now() - 300000)}
      LIMIT 1
    `;

    if (existingEvent.length > 0) {
      console.log(`[Protractor Callback] Duplicate event for ${workOrderId}, skipping`);
      return NextResponse.json({ ok: true, duplicate: true });
    }

    await sql`
      INSERT INTO protractor_callback_events (
        received_at, payload, work_order_id, status, connection_id, shop_id, processed
      )
      VALUES (NOW(), ${JSON.stringify(payload)}, ${workOrderId}, ${status || null}, ${connectionId}, ${shop.shop_id}, FALSE)
    `;

    const normalizedStatus = (status || "").toUpperCase();
    const isClosed = VALID_TERMINAL_STATUSES.includes(normalizedStatus);

    if (isClosed) {
      console.log(`[Protractor Callback] Work order ${workOrderId} closed with status: ${status} (shop: ${shop.shop_id})`);

      const existingWorkOrder = await sql`
        SELECT id FROM protractor_work_orders
        WHERE shop_id = ${shop.shop_id} AND work_order_guid = ${workOrderId}
        LIMIT 1
      `;

      if (existingWorkOrder.length === 0) {
        console.log(`[Protractor Callback] Work order ${workOrderId} not found in our records, skipping`);
        return NextResponse.json({ ok: true, skipped: true, reason: "Unknown work order" });
      }

      const vehicleResult = await sql`
        SELECT id, vin, status FROM vehicles
        WHERE shop_id = ${shop.shop_id}
          AND (status->>'active')::boolean = TRUE
          AND status->'sources' @> ${JSON.stringify([{ provider: "protractor", workOrderId: workOrderId }])}
        LIMIT 1
      `;

      if (vehicleResult.length > 0) {
        const vehicle = vehicleResult[0];
        const existingSources = (vehicle.status as Record<string, unknown>)?.sources as Record<string, unknown>[] || [];
        const updatedSources = existingSources.filter(
          (s: Record<string, unknown>) => !(s.provider === "protractor" && String(s.workOrderId) === String(workOrderId))
        );
        const hasActiveSources = updatedSources.length > 0;

        const newStatus = {
          ...vehicle.status as Record<string, unknown>,
          active: hasActiveSources,
          sources: updatedSources,
          ...(hasActiveSources ? {} : { lastClosedAt: new Date().toISOString() })
        };

        await sql`
          UPDATE vehicles
          SET status = ${JSON.stringify(newStatus)}, updated_at = NOW()
          WHERE id = ${vehicle.id}
        `;

        console.log(`[Protractor Callback] Vehicle ${vehicle.vin} updated - active: ${hasActiveSources}`);
      }

      await sql`
        UPDATE protractor_work_orders
        SET workflow_stage = ${status || null}, status = ${status || null}, 
            closed_at = NOW(), closed_via_callback = TRUE, updated_at = NOW()
        WHERE work_order_guid = ${workOrderId}
      `;

      await sql`
        UPDATE protractor_callback_events
        SET processed = TRUE, processed_at = NOW()
        WHERE work_order_id = ${workOrderId} AND status = ${status || null} AND processed = FALSE
      `;
    }

    return NextResponse.json({ 
      ok: true, 
      workOrderId,
      status,
      isClosed 
    });

  } catch (error: unknown) {
    console.error("[Protractor Callback] Error:", error);
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ 
    status: "ok", 
    endpoint: "Protractor Callback Receiver",
    usage: "POST work order updates to this endpoint"
  });
}
