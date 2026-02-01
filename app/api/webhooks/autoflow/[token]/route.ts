// app/api/webhooks/autoflow/[token]/route.ts
import { NextRequest, NextResponse } from "next/server";
import sql from "@/lib/db/postgres";
import crypto from "node:crypto";
import { fetchDviByInvoice, upsertDviSnapshot } from "@/lib/integrations/autoflow";
import { upsertCustomerFromEvent } from "@/lib/upsert-customer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  const rows = await sql`
    SELECT shop_id, name FROM shops WHERE webhook_token = ${token}
  `;
  return rows[0] as any;
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

export async function GET(req: NextRequest, ctx: { params: { token: string } }) {
  const token = ctx.params?.token || "";
  if (!token) return NextResponse.json({ error: "missing token" }, { status: 400 });

  const isPing = req.nextUrl.searchParams.has("ping");
  const shop = await findShopByToken(token);
  if (!shop) return NextResponse.json({ error: "invalid token" }, { status: 401 });

  if (isPing) {
    return NextResponse.json({ ok: true, shopId: shop.shop_id, tokenValid: true });
  }
  return NextResponse.json({ ok: true, shopId: shop.shop_id });
}

export async function POST(req: NextRequest, ctx: { params: { token: string } }) {
  const token = ctx.params?.token || "";
  if (!token) return NextResponse.json({ error: "missing token" }, { status: 400 });

  const shop = await findShopByToken(token);
  if (!shop) return NextResponse.json({ error: "invalid token" }, { status: 401 });

  const raw = await req.text();
  let payload: any = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    // keep payload as null; raw is still saved
  }

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

  await sql`
    INSERT INTO events (provider, shop_id, token, payload, raw, received_at)
    VALUES ('autoflow', ${shop.shop_id}, ${token}, ${payload ? JSON.stringify(payload) : null}::jsonb, ${raw}, NOW())
  `;

  try {
    const eventName = String(getEventName(payload)).toLowerCase();
    const shopId = Number(shop.shop_id);

    await upsertCustomerFromEvent(shopId, payload);

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

      if (vin) {
        await sql`
          UPDATE customers SET status = 'closed', closed_at = ${now}, updated_at = ${now}
          WHERE shop_id = ${String(shopId)} AND vehicle_vin = ${vin}
        `;
      }
    }

    const isDviEvent = /dvi/i.test(eventName) && /(signoff|complete|completed|update)/i.test(eventName);

    const roNumber =
      payload?.ticket?.invoice ??
      payload?.ticket?.id ??
      payload?.event?.invoice ??
      null;

    if (isDviEvent && roNumber != null) {
      const dvi = await fetchDviByInvoice(shopId, String(roNumber));
      await upsertDviSnapshot(shopId, String(roNumber), dvi);
    }
  } catch (e) {
    console.error("Webhook normalization error:", e);
  }

  return NextResponse.json({ ok: true, shopId: shop.shop_id });
}
