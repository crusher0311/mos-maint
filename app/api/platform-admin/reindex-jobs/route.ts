import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { reindexFromStoredData } from "@/lib/tekmetric-job-index";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const SUPER_ADMINS = ["brandoncrusha@gmail.com", "brandoncrusha+1@gmail.com"];

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || !SUPER_ADMINS.includes(session.email)) {
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
