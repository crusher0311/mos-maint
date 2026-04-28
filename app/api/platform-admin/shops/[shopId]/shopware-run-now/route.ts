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
  // Same connectivity guard as the existing manual-backfill endpoint
  // (app/api/platform-admin/shops/[shopId]/backfill/route.ts) — fail fast
  // for shops without a Shop-Ware tenantId so the cron isn't asked to
  // process a shop that can't be backfilled.
  if (!shop.shopware?.tenantId) {
    return NextResponse.json(
      { error: "Shop is not connected to Shop-Ware" },
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
    `[Platform Admin] Shop-Ware run-now requested for shop ${shopId} by ${session.email}`
  );

  await db.collection("audit_logs").insertOne({
    type: "shopware_run_now",
    shopId,
    shopName: shop.name,
    adminEmail: session.email,
    createdAt: new Date(),
  });

  const startedAt = Date.now();
  try {
    // The Shop-Ware cron's `?shopId=` branch already runs synchronously and
    // returns chunk metrics for that shop, so we can forward the response
    // through the same way the Tekmetric run-now does.
    const upstream = await fetch(
      `${baseUrl}/api/cron/shopware-backfill?shopId=${shopId}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cronSecret}`,
        },
      }
    );

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

    const result = Array.isArray(json?.results) ? json.results[0] : null;
    return NextResponse.json({
      ok: true,
      shopId,
      shopName: shop.name,
      result,
      message:
        json?.message ||
        (result
          ? `Ran ${result.chunksProcessed ?? 0} chunk(s) for shop ${shopId}`
          : `No work to do for shop ${shopId}`),
      duration: json?.duration || `${Date.now() - startedAt}ms`,
    });
  } catch (err: any) {
    console.error(
      `[Platform Admin] Shop-Ware run-now failed for shop ${shopId}:`,
      err
    );
    return NextResponse.json(
      { error: err?.message || "Failed to run Shop-Ware backfill chunk" },
      { status: 500 }
    );
  }
}
