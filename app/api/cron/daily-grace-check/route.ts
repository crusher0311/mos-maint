import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  console.log(`[Cron] Daily grace period check triggered at ${new Date().toISOString()}`);

  try {
    const baseUrl = process.env.RENDER_EXTERNAL_URL 
      || process.env.NEXT_PUBLIC_BASE_URL
      || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : null)
      || `http://localhost:${process.env.PORT || 5000}`;
    
    const response = await fetch(`${baseUrl}/api/admin/billing/grace-period-check`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(CRON_SECRET ? { "Authorization": `Bearer ${CRON_SECRET}` } : {}),
      },
    });
    
    if (!response.ok) {
      const text = await response.text();
      console.error(`[Cron] Grace period check failed: HTTP ${response.status} - ${text}`);
      return NextResponse.json({ 
        error: `Grace period check failed: ${response.status}`,
        details: text 
      }, { status: response.status });
    }
    
    const result = await response.json();
    console.log(`[Cron] Grace period check completed:`, result);
    
    return NextResponse.json({
      ok: true,
      timestamp: new Date().toISOString(),
      ...result,
    });
  } catch (error: any) {
    console.error(`[Cron] Grace period check error:`, error);
    return NextResponse.json({ 
      error: error.message || "Unknown error" 
    }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return GET(req);
}
