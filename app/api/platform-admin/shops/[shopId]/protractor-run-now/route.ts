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
  // Mirrors the connectivity check in
  // app/api/platform-admin/shops/[shopId]/backfill/route.ts so we fail fast
  // for shops that aren't actually wired to Protractor instead of starting a
  // backfill that would no-op inside the cron.
  const hasProtractor =
    shop.protractor?.configured ||
    shop.protractor?.apiKey ||
    shop.protractor?.connectionId ||
    shop.protractorApiKey ||
    shop.protractorConnectionId;
  if (!hasProtractor) {
    return NextResponse.json(
      { error: "Shop is not connected to Protractor" },
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
    `[Platform Admin] Protractor run-now requested for shop ${shopId} by ${session.email}`
  );

  await db.collection("audit_logs").insertOne({
    type: "protractor_run_now",
    shopId,
    shopName: shop.name,
    adminEmail: session.email,
    createdAt: new Date(),
  });

  const startedAt = Date.now();
  try {
    // The Protractor cron's `?shopId=` branch defaults to fire-and-forget
    // for the existing settings-flow callers; opt in to `?wait=1` so the
    // chunk metrics flow back inline (mirrors the Tekmetric/Shop-Ware
    // run-now UX in the admin sync-health view).
    const upstream = await fetch(
      `${baseUrl}/api/cron/protractor-backfill?shopId=${shopId}&wait=1`,
      {
        method: "GET",
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

    const result = json?.result || null;
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
      duration: `${Date.now() - startedAt}ms`,
    });
  } catch (err: any) {
    console.error(
      `[Platform Admin] Protractor run-now failed for shop ${shopId}:`,
      err
    );
    return NextResponse.json(
      { error: err?.message || "Failed to run Protractor backfill chunk" },
      { status: 500 }
    );
  }
}
