import { NextRequest, NextResponse } from "next/server";
import sql from "@/lib/db/postgres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const INTERNAL_SECRET = process.env.INTERNAL_WORKER_SECRET || "mos-prefetch-worker-2024";

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("x-internal-secret");
  if (authHeader !== INTERNAL_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shops = await sql`
    SELECT shop_id, settings FROM shops 
    WHERE settings->'cachedLaborRate' IS NULL 
       OR (settings->>'cachedLaborRate')::numeric = 0
  `;

  let updated = 0;
  for (const shop of shops) {
    const recentJobRows = await sql`
      SELECT lines FROM job_index 
      WHERE shop_id = ${shop.shop_id} 
        AND lines @> '[{"lineType": "labor"}]'::jsonb
      ORDER BY performed_at DESC
      LIMIT 1
    `;
    const recentJob = recentJobRows[0];
    
    if (recentJob?.lines) {
      const laborLine = recentJob.lines.find((l: any) => l.lineType === "labor" && l.unitPrice > 0);
      if (laborLine) {
        const currentSettings = shop.settings || {};
        const updatedSettings = {
          ...currentSettings,
          cachedLaborRate: laborLine.unitPrice,
          cachedLaborRateUpdatedAt: new Date().toISOString()
        };
        
        await sql`
          UPDATE shops SET settings = ${JSON.stringify(updatedSettings)}::jsonb
          WHERE shop_id = ${shop.shop_id}
        `;
        updated++;
        console.log(`[Backfill] Shop ${shop.shop_id}: $${laborLine.unitPrice}/hr`);
      }
    }
  }

  return NextResponse.json({ ok: true, shopsChecked: shops.length, updated });
}
