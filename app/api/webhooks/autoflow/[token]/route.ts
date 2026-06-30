// app/api/webhooks/autoflow/[token]/route.ts
//
// Legacy per-shop AutoFlow webhook URL. Kept for backward compatibility with
// any location already configured with a token URL. New configs should use the
// single-source URL (app/api/webhooks/autoflow/route.ts) which resolves the
// shop from the payload. Shared processing lives in lib/integrations/autoflow/webhook.ts.
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import {
  verifyHmacSHA256,
  processAutoflowWebhookEvent,
} from "@/lib/integrations/autoflow/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function findShopByToken(token: string) {
  const db = await getDb();
  return db
    .collection("shops")
    .findOne({ webhookToken: token }, { projection: { shopId: 1, name: 1 } });
}

// ---- GET: token validity ------------------------------------------------

export async function GET(req: NextRequest, ctx: { params: { token: string } }) {
  const token = ctx.params?.token || "";
  if (!token) return NextResponse.json({ error: "missing token" }, { status: 400 });

  const isPing = req.nextUrl.searchParams.has("ping");
  const shop = await findShopByToken(token);
  if (!shop) return NextResponse.json({ error: "invalid token" }, { status: 401 });

  if (isPing) {
    return NextResponse.json({ ok: true, shopId: shop.shopId, tokenValid: true });
  }
  return NextResponse.json({ ok: true, shopId: shop.shopId });
}

// ---- POST: accept webhook -----------------------------------------------

export async function POST(req: NextRequest, ctx: { params: { token: string } }) {
  const token = ctx.params?.token || "";
  if (!token) return NextResponse.json({ error: "missing token" }, { status: 400 });

  const shop = await findShopByToken(token);
  if (!shop) return NextResponse.json({ error: "invalid token" }, { status: 401 });

  // Read raw body for optional HMAC verification and for safe logging
  const raw = await req.text();
  let payload: any = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    // keep payload as null; raw is still saved
  }

  // OPTIONAL signature verification (enable by setting AUTOFLOW_SIGNING_SECRET)
  const secret = process.env.AUTOFLOW_SIGNING_SECRET || "";
  if (secret) {
    const sig =
      req.headers.get("x-autoflow-signature") ||
      req.headers.get("x-signature") ||
      "";
    if (!sig || !verifyHmacSHA256(secret, raw, sig)) {
      return NextResponse.json({ error: "invalid signature" }, { status: 401 });
    }
  }

  const db = await getDb();
  await processAutoflowWebhookEvent({ db, shop, token, raw, payload });

  return NextResponse.json({ ok: true, shopId: shop.shopId });
}
