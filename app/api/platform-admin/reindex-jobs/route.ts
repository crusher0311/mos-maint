import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { reindexFromStoredData } from "@/lib/tekmetric-job-index";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || !session.isPlatformAdmin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const shopId = body.shopId ? Number(body.shopId) : undefined;

  try {
    const result = await reindexFromStoredData(shopId);
    return NextResponse.json({
      success: true,
      ...result,
      message: `Reindexed ${result.jobsReindexed} jobs from ${result.rosProcessed} stored repair orders${shopId ? ` for shop ${shopId}` : ""}`
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
