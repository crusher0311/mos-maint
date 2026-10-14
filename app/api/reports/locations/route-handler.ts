import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { resolveReportingScope, ReportingScopeError } from "@/lib/reporting-scope";

export const __deps = { getSession, resolveReportingScope };

// Authorization metadata only: never runs a report or queries invoice history.
export async function GET(req: NextRequest) {
  const headers = { "Cache-Control": "private, no-store" };
  const session = await __deps.getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });
  try {
    const p = req.nextUrl.searchParams;
    const scope = await __deps.resolveReportingScope(session, {
      kind: p.get("scope"), shopId: p.get("shopId"), enterpriseId: p.get("enterpriseId"),
    });
    return NextResponse.json({
      locations: scope.shops.map(shop => ({ key: String(shop.shopId), label: shop.name })),
    }, { headers });
  } catch (error) {
    return NextResponse.json({ error: "Unable to load authorized reporting locations." }, {
      status: error instanceof ReportingScopeError ? error.status : 503, headers,
    });
  }
}
