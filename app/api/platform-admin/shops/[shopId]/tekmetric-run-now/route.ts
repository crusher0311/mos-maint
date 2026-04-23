import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(
  req: NextRequest,
  { params }: { params: { shopId: string } }
) {
  const session = await getSession();
  if (!session?.isPlatformAdmin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shopId = Number(params.shopId);
  if (isNaN(shopId)) {
    return NextResponse.json({ error: "Invalid shop ID" }, { status: 400 });
  }

  const db = await getDb();
  const shop = await db.collection("shops").findOne({ shopId });
  if (!shop) {
    return NextResponse.json({ error: "Shop not found" }, { status: 404 });
  }
  const tekmetricShopId = shop.tekmetric?.shopId || shop.tekmetricShopId;
  if (!tekmetricShopId) {
    return NextResponse.json(
      { error: "Shop is not connected to Tekmetric" },
      { status: 400 }
    );
  }

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured on the server" },
      { status: 500 }
    );
  }

  const baseUrl = process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : process.env.NEXT_PUBLIC_APP_URL || "http://localhost:5000";

  console.log(
    `[Platform Admin] Tekmetric run-now requested for shop ${shopId} by ${session.email}`
  );

  await db.collection("audit_logs").insertOne({
    type: "tekmetric_run_now",
    shopId,
    shopName: shop.name,
    adminEmail: session.email,
    createdAt: new Date(),
  });

  try {
    const upstream = await fetch(`${baseUrl}/api/cron/tekmetric-backfill`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cronSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ shopId }),
    });

    const json = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      return NextResponse.json(
        {
          error:
            json?.error ||
            `Cron returned ${upstream.status} ${upstream.statusText}`,
        },
        { status: upstream.status }
      );
    }

    const result = Array.isArray(json?.processed) ? json.processed[0] : null;
    return NextResponse.json({
      ok: true,
      shopId,
      shopName: shop.name,
      result,
      message:
        json?.message ||
        (result
          ? `Ran ${result.chunksProcessed} chunk(s) for shop ${shopId}`
          : `No work to do for shop ${shopId}`),
      duration: json?.duration,
      tekmetricApiCalls: json?.tekmetricApiCalls,
    });
  } catch (err: any) {
    console.error(
      `[Platform Admin] Tekmetric run-now failed for shop ${shopId}:`,
      err
    );
    return NextResponse.json(
      { error: err?.message || "Failed to run Tekmetric backfill chunk" },
      { status: 500 }
    );
  }
}
