import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getShopRequests, ApiProvider } from "@/lib/api-usage-tracker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: { shopId: string } }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!session.isPlatformAdmin) {
    return NextResponse.json({ error: "Forbidden - platform admin access required" }, { status: 403 });
  }

  try {
    const shopId = parseInt(params.shopId);
    if (isNaN(shopId)) {
      return NextResponse.json({ error: "Invalid shop ID" }, { status: 400 });
    }

    const { searchParams } = new URL(request.url);
    const provider = searchParams.get('provider') as ApiProvider | null;
    const hours = parseInt(searchParams.get('hours') || '1');
    const limit = parseInt(searchParams.get('limit') || '50');
    const cursor = searchParams.get('cursor');

    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const result = await getShopRequests(shopId, {
      provider: provider || undefined,
      since,
      limit,
      cursor: cursor || undefined
    });

    return NextResponse.json(result);
  } catch (error: any) {
    console.error("[Platform Admin] Shop requests error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
