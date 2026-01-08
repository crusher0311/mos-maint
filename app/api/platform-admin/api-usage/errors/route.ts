import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getErrorDetails, getErrorBreakdown, ApiProvider } from "@/lib/api-usage-tracker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.isPlatformAdmin) {
    return NextResponse.json({ error: "Forbidden - platform admin access required" }, { status: 403 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get('provider') as ApiProvider | null;
    const shopId = searchParams.get('shopId');
    const statusCode = searchParams.get('statusCode');
    const hours = parseInt(searchParams.get('hours') || '1');
    const limit = parseInt(searchParams.get('limit') || '50');
    const cursor = searchParams.get('cursor');
    const breakdown = searchParams.get('breakdown') === 'true';

    if (breakdown) {
      const breakdownData = await getErrorBreakdown(provider || undefined);
      return NextResponse.json(breakdownData);
    }

    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const result = await getErrorDetails({
      provider: provider || undefined,
      shopId: shopId ? parseInt(shopId) : undefined,
      statusCode: statusCode ? parseInt(statusCode) : undefined,
      since,
      limit,
      cursor: cursor || undefined
    });

    return NextResponse.json(result);
  } catch (error: any) {
    console.error("[Platform Admin] Error details error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
