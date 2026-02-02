// app/api/webhooks/autoflow/[token]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import crypto from "node:crypto";
import { fetchDviByInvoice, upsertDviSnapshot } from "@/lib/integrations/autoflow";
import { upsertCustomerFromEvent } from "@/lib/upsert-customer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---- Helpers -------------------------------------------------------------

function timingSafeEqual(a: Buffer, b: Buffer) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function verifyHmacSHA256(secret: string, rawBody: string, signatureHex: string) {
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(signatureHex, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

async function findShopByToken(token: string) {
  const db = await getDb();
  return db
    .collection("shops")
    .findOne({ webhookToken: token }, { projection: { shopId: 1, name: 1 } });
}

function getEventName(payload: any): string {
  return (
    payload?.event?.type ||
    payload?.event ||
    payload?.type ||
    payload?.name ||
    ""
  );
}

function resolveVin(payload: any): string | null {
  return (
    payload?.vin ??
    payload?.vehicle?.vin ??
    payload?.data?.vehicle?.vin ??
    payload?.ticket?.vehicle?.vin ??
    null
  )
    ? String(
        payload?.vin ??
          payload?.vehicle?.vin ??
          payload?.data?.vehicle?.vin ??
          payload?.ticket?.vehicle?.vin
      )
        .trim()
        .toUpperCase()
    : null;
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

  // Persist raw event for audit / console
  await db.collection("events").insertOne({
    provider: "autoflow",
    shopId: shop.shopId,
    token,
    payload,
    raw,
    receivedAt: new Date(),
  });

  // ---- Normalize into first-class docs so dashboards light up ---------
  try {
    const eventName = String(getEventName(payload)).toLowerCase();

    // 1) Ensure/refresh a customer row for dashboard lists
    await upsertCustomerFromEvent(db, Number(shop.shopId), payload);

    // 2) Optionally mark a customer closed on terminal events
    const closeTypes = new Set<string>([
      "dvi_signoff",
      "dvi.signoff",
      "dvi_completed",
      "dvi.completed",
      "work_completed",
      "ticket_closed",
      "ticket.closed",
      "close",
      "closed",
    ]);

    if (closeTypes.has(eventName)) {
      const now = new Date();
      const vin = resolveVin(payload);
      const shopOr = [{ shopId: shop.shopId }, { shopId: Number(shop.shopId) }];

      await db.collection("customers").updateOne(
        {
          $and: [
            { $or: shopOr as any },
            vin ? { "vehicle.vin": vin } : {},
          ],
        },
        { $set: { status: "closed", closedAt: now, updatedAt: now } }
      );
    }

    // 3) Auto-fetch DVI snapshot on signoff/completion-ish events
    const isDviEvent = /dvi/i.test(eventName) && /(signoff|complete|completed|update)/i.test(eventName);

    const roNumber =
      payload?.ticket?.invoice ??
      payload?.ticket?.id ??
      payload?.event?.invoice ??
      null;

    if (isDviEvent && roNumber != null) {
      const dvi = await fetchDviByInvoice(Number(shop.shopId), String(roNumber));
      await upsertDviSnapshot(Number(shop.shopId), String(roNumber), dvi);
    }
  } catch (e) {
    // Swallow normalization errors; raw event is still stored for replay
    console.error("Webhook normalization error:", e);
  }

  return NextResponse.json({ ok: true, shopId: shop.shopId });
}
