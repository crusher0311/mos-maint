import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import { getSession } from "@/lib/auth";
import crypto from "crypto";

const SHARE_SECRET = process.env.REPORT_SHARE_SECRET || process.env.STRIPE_WEBHOOK_SECRET || "vhr-share-default-key";
const TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function generateShareToken(vin: string, shopId: string, expiresAt: number): string {
  const payload = `${vin}:${shopId}:${expiresAt}`;
  const signature = crypto.createHmac("sha256", SHARE_SECRET).update(payload).digest("hex").slice(0, 16);
  return Buffer.from(`${payload}:${signature}`).toString("base64url");
}

function verifyShareToken(token: string): { vin: string; shopId: string } | null {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf-8");
    const parts = decoded.split(":");
    if (parts.length !== 4) return null;
    const [vin, shopId, expiresStr, signature] = parts;
    const expiresAt = parseInt(expiresStr, 10);
    if (Date.now() > expiresAt) return null;
    const payload = `${vin}:${shopId}:${expiresAt}`;
    const expected = crypto.createHmac("sha256", SHARE_SECRET).update(payload).digest("hex").slice(0, 16);
    if (signature !== expected) return null;
    return { vin, shopId };
  } catch {
    return null;
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: { vin: string } }
) {
  try {
    const vin = params.vin?.toUpperCase();
    const token = req.nextUrl.searchParams.get("token");

    if (!vin) {
      return NextResponse.json({ error: "Missing VIN" }, { status: 400 });
    }

    let shopId: string | null = null;

    if (token) {
      const verified = verifyShareToken(token);
      if (!verified || verified.vin !== vin) {
        return NextResponse.json({ error: "Invalid or expired report link" }, { status: 403 });
      }
      shopId = verified.shopId;
    } else {
      return NextResponse.json({ error: "A valid share link is required to view this report" }, { status: 403 });
    }

    const db = await getDb();

    const shop = await db.collection("shops").findOne({
      $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }],
    });
    if (!shop) {
      return NextResponse.json({ error: "Shop not found" }, { status: 404 });
    }

    const cachedPlan = await db.collection("cached_plans").findOne(
      {
        vin,
        shopId: { $in: [String(shopId), Number(shopId)] },
        expiresAt: { $gt: new Date() },
      },
      { sort: { createdAt: -1 } }
    );

    if (!cachedPlan?.plan) {
      return NextResponse.json({ error: "No plan found for this vehicle. Visit the Vehicle Health Indicator page first to generate a plan." }, { status: 404 });
    }

    const plan = cachedPlan.plan;

    return NextResponse.json({
      plan: {
        vehicle: plan.vehicle || {},
        vin,
        currentMiles: plan.currentMiles || cachedPlan.mileage || 0,
        customerName: plan.customerName || "Vehicle Owner",
        buckets: {
          overdue: plan.overdue || [],
          dueSoon: plan.dueSoon || [],
          upcoming: plan.upcoming || [],
        },
      },
      shopName: shop.name || shop.shopName || "",
      shopPhone: shop.phone || shop.contact?.phone || "",
    });
  } catch (err: any) {
    console.error("[Report API] Error:", err.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: { vin: string } }
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const vin = params.vin?.toUpperCase();
    const shopId = session.shopId;

    if (!vin || !shopId) {
      return NextResponse.json({ error: "Missing vin or shopId" }, { status: 400 });
    }

    const expiresAt = Date.now() + TOKEN_MAX_AGE_MS;
    const token = generateShareToken(vin, String(shopId), expiresAt);

    const host = req.headers.get("host") || req.nextUrl.host;
    const protocol = req.headers.get("x-forwarded-proto") || "https";
    const shareUrl = `${protocol}://${host}/report/${vin}?token=${token}`;

    return NextResponse.json({
      shareUrl,
      token,
      expiresAt,
      expiresIn: "7 days",
    });
  } catch (err: any) {
    console.error("[Report API] Error generating share link:", err.message);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
