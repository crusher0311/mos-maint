import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import {
  resendCardCaptureForShop,
  type CardCaptureResult,
} from "@/lib/card-capture-resend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Hard cap on a single batch so a stray click can't kick off thousands of
// emails (and tens of thousands of Stripe API calls) at once.
const MAX_BULK_SHOPS = 500;

// Sleep between sends — Stripe customers/checkout sessions and the email
// provider both have per-second rate limits. ~5 sends/sec is well under
// Stripe's default 25 RPS while still finishing 100 shops in ~20 seconds.
const PER_SEND_DELAY_MS = 200;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.isPlatformAdmin) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => null);
    const rawShopIds: unknown = body?.shopIds;
    if (!Array.isArray(rawShopIds) || rawShopIds.length === 0) {
      return NextResponse.json(
        { error: "shopIds (non-empty array) is required" },
        { status: 400 },
      );
    }
    if (rawShopIds.length > MAX_BULK_SHOPS) {
      return NextResponse.json(
        { error: `Too many shops: max ${MAX_BULK_SHOPS} per request` },
        { status: 400 },
      );
    }

    // Normalize to numeric where possible; preserve unique order.
    const seen = new Set<string>();
    const shopIds: (number | string)[] = [];
    for (const raw of rawShopIds) {
      const id =
        typeof raw === "number"
          ? raw
          : typeof raw === "string"
            ? Number.isFinite(Number(raw))
              ? Number(raw)
              : raw
            : null;
      if (id === null) continue;
      const key = String(id);
      if (seen.has(key)) continue;
      seen.add(key);
      shopIds.push(id);
    }

    if (shopIds.length === 0) {
      return NextResponse.json(
        { error: "No valid shopIds provided" },
        { status: 400 },
      );
    }

    const db = await getDb();
    const startedAt = new Date();
    const results: CardCaptureResult[] = [];

    // Sequential w/ small delay = simple, safe rate limit. Avoids
    // hammering Stripe and the SMTP provider when admins push to a
    // large cohort at end-of-quarter.
    for (let i = 0; i < shopIds.length; i++) {
      const shopId = shopIds[i];
      try {
        const result = await resendCardCaptureForShop({
          db,
          shopId,
          adminEmail: session.email,
        });
        results.push(result);
      } catch (err: any) {
        // resendCardCaptureForShop catches its own errors, but guard
        // against an unexpected throw so one bad shop can't kill the batch.
        console.error(
          `[Platform Admin] Unexpected bulk card-capture error for shop ${shopId}:`,
          err?.message,
        );
        results.push({
          ok: false,
          shopId,
          error: err?.message || "Unexpected error",
        });
      }
      if (i < shopIds.length - 1) {
        await sleep(PER_SEND_DELAY_MS);
      }
    }

    const succeeded = results.filter((r) => r.ok).length;
    const failed = results.length - succeeded;

    await db.collection("audit_logs").insertOne({
      type: "shop_card_capture_email_bulk_resent",
      adminEmail: session.email,
      requestedCount: shopIds.length,
      succeeded,
      failed,
      results: results.map((r) => ({
        shopId: r.shopId,
        shopName: r.shopName,
        ownerEmail: r.ownerEmail,
        ok: r.ok,
        mode: r.mode,
        error: r.error,
        stripeCheckoutSessionId: r.stripeCheckoutSessionId,
      })),
      startedAt,
      finishedAt: new Date(),
      createdAt: new Date(),
    });

    return NextResponse.json({
      ok: true,
      requestedCount: shopIds.length,
      succeeded,
      failed,
      results,
    });
  } catch (err: any) {
    console.error("Bulk card-capture error:", err);
    return NextResponse.json(
      { error: err?.message || "Server error" },
      { status: 500 },
    );
  }
}
