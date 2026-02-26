import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const secretParam = req.nextUrl.searchParams.get("secret");
  
  const isAuthorized = 
    (CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`) ||
    (CRON_SECRET && secretParam === CRON_SECRET) ||
    !CRON_SECRET;
  
  if (!isAuthorized) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  console.log(`[Cron] Daily-all triggered at ${new Date().toISOString()}`);

  const baseUrl = process.env.RENDER_EXTERNAL_URL 
    || process.env.NEXT_PUBLIC_BASE_URL
    || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : null)
    || `http://localhost:${process.env.PORT || 5000}`;

  const results: Record<string, any> = {};

  try {
    console.log(`[Cron] Running grace period check...`);
    const graceResponse = await fetch(`${baseUrl}/api/admin/billing/grace-period-check`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(CRON_SECRET ? { "Authorization": `Bearer ${CRON_SECRET}` } : {}),
      },
    });
    
    if (graceResponse.ok) {
      results.gracePeriodCheck = await graceResponse.json();
      console.log(`[Cron] Grace period check completed`);
    } else {
      results.gracePeriodCheck = { 
        error: `HTTP ${graceResponse.status}`, 
        details: await graceResponse.text() 
      };
      console.error(`[Cron] Grace period check failed:`, results.gracePeriodCheck);
    }
  } catch (error: any) {
    results.gracePeriodCheck = { error: error.message };
    console.error(`[Cron] Grace period check error:`, error);
  }

  try {
    console.log(`[Cron] Running Protractor sync...`);
    const protractorResponse = await fetch(`${baseUrl}/api/cron/protractor-sync`, {
      method: "GET",
      headers: {
        ...(CRON_SECRET ? { "Authorization": `Bearer ${CRON_SECRET}` } : {}),
      },
    });
    
    if (protractorResponse.ok) {
      results.protractorSync = await protractorResponse.json();
      console.log(`[Cron] Protractor sync completed`);
    } else {
      results.protractorSync = { 
        error: `HTTP ${protractorResponse.status}`, 
        details: await protractorResponse.text() 
      };
      console.error(`[Cron] Protractor sync failed:`, results.protractorSync);
    }
  } catch (error: any) {
    results.protractorSync = { error: error.message };
    console.error(`[Cron] Protractor sync error:`, error);
  }

  try {
    console.log(`[Cron] Running Shop-Ware sync...`);
    const shopwareResponse = await fetch(`${baseUrl}/api/cron/shopware-sync`, {
      method: "GET",
      headers: {
        ...(CRON_SECRET ? { "Authorization": `Bearer ${CRON_SECRET}` } : {}),
      },
    });

    if (shopwareResponse.ok) {
      results.shopwareSync = await shopwareResponse.json();
      console.log(`[Cron] Shop-Ware sync completed`);
    } else {
      results.shopwareSync = {
        error: `HTTP ${shopwareResponse.status}`,
        details: await shopwareResponse.text(),
      };
      console.error(`[Cron] Shop-Ware sync failed:`, results.shopwareSync);
    }
  } catch (error: any) {
    results.shopwareSync = { error: error.message };
    console.error(`[Cron] Shop-Ware sync error:`, error);
  }

  try {
    console.log(`[Cron] Running Shop-Ware enrich...`);
    const shopwareEnrichResponse = await fetch(`${baseUrl}/api/cron/shopware-enrich?batch=500`, {
      headers: CRON_SECRET ? { Authorization: `Bearer ${CRON_SECRET}` } : {},
    });
    if (shopwareEnrichResponse.ok) {
      results.shopwareEnrich = await shopwareEnrichResponse.json();
    } else {
      results.shopwareEnrich = {
        error: `HTTP ${shopwareEnrichResponse.status}`,
        details: await shopwareEnrichResponse.text(),
      };
      console.error(`[Cron] Shop-Ware enrich failed:`, results.shopwareEnrich);
    }
  } catch (error: any) {
    results.shopwareEnrich = { error: error.message };
    console.error(`[Cron] Shop-Ware enrich error:`, error);
  }

  const duration = Date.now() - startTime;
  console.log(`[Cron] Daily-all completed in ${duration}ms`);

  return NextResponse.json({
    ok: true,
    timestamp: new Date().toISOString(),
    duration: `${duration}ms`,
    results,
  });
}

export async function POST(req: NextRequest) {
  return GET(req);
}
