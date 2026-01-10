import { NextRequest, NextResponse } from "next/server";
import { requirePlatformAdmin } from "@/lib/auth";
import { getAuditLogs } from "@/lib/audit-log";

export async function GET(request: NextRequest) {
  try {
    await requirePlatformAdmin();

    const { searchParams } = new URL(request.url);
    const adminEmail = searchParams.get('adminEmail') || undefined;
    const action = searchParams.get('action') || undefined;
    const shopId = searchParams.get('shopId');
    const days = parseInt(searchParams.get('days') || '7', 10);
    const limit = Math.min(500, parseInt(searchParams.get('limit') || '100', 10));

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const logs = await getAuditLogs({
      adminEmail,
      action: action as any,
      targetShopId: shopId ? Number(shopId) : undefined,
      since,
      limit
    });

    return NextResponse.json({
      logs,
      count: logs.length,
      filters: { adminEmail, action, shopId, days, limit }
    });
  } catch (error: any) {
    console.error("[Admin AuditLogs] Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
