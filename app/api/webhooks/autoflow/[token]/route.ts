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

      // Cross-reference this DVI back to the matching primary-SMS work order
      // so downstream joins are cheap and we can flag mismatches (a DVI for
      // an RO we have no record of) for diagnostics. Reconciliation key is
      // shopId + RO number, with VIN fallback when RO numbers don't line up
      // (Autoflow sometimes carries the invoice number while the primary
      // system carries a different work-order number).
      try {
        const sId = Number(shop.shopId);
        const sIds: any[] = [sId, String(sId)];
        const roStr = String(roNumber);
        const vinForXref =
          (dvi as any)?.vin?.toUpperCase() || resolveVin(payload) || null;
        const vinOr = vinForXref ? [{ vin: vinForXref }] : [];

        const [tekWo, protWo, swRo] = await Promise.all([
          db.collection("tekmetric_work_orders").findOne(
            {
              shopId: { $in: sIds },
              $or: [
                { workOrderNumber: roStr },
                { repairOrderNumber: roStr },
                ...vinOr,
              ],
            },
            { projection: { workOrderId: 1, workOrderNumber: 1, repairOrderNumber: 1, vin: 1 } }
          ),
          db.collection("protractor_work_orders").findOne(
            {
              shopId: { $in: sIds },
              $or: [
                { workOrderNumber: roStr },
                { "data.WorkOrderNumber": roStr },
                ...vinOr,
              ],
            },
            { projection: { workOrderGuid: 1, workOrderNumber: 1, vin: 1 } }
          ),
          db.collection("shopware_repair_orders").findOne(
            {
              mosShopId: { $in: sIds },
              $or: [
                { number: roStr },
                { number: Number(roStr) },
                ...vinOr,
              ],
            },
            { projection: { roId: 1, number: 1, vin: 1 } }
          ),
        ]);

        const xref: Record<string, any> = {};
        if (tekWo) {
          xref.tekmetric = {
            workOrderId: tekWo.workOrderId ?? null,
            workOrderNumber: tekWo.workOrderNumber ?? tekWo.repairOrderNumber ?? null,
            matchedBy: String(tekWo.workOrderNumber ?? tekWo.repairOrderNumber ?? "") === roStr ? "ro" : "vin",
          };
        }
        if (protWo) {
          xref.protractor = {
            workOrderGuid: protWo.workOrderGuid ?? null,
            workOrderNumber: protWo.workOrderNumber ?? null,
            matchedBy: String(protWo.workOrderNumber ?? "") === roStr ? "ro" : "vin",
          };
        }
        if (swRo) {
          xref.shopware = {
            roId: swRo.roId ?? null,
            number: swRo.number ?? null,
            matchedBy: String(swRo.number ?? "") === roStr ? "ro" : "vin",
          };
        }

        const matched = Object.keys(xref).length > 0;
        // Normalize shopId/roNumber forms so the cross-reference always
        // lands on the snapshot we just upserted, even if a future caller
        // stores `shopId` as a string or `roNumber` as a number.
        const updateRes = await db.collection("dvi_results").updateOne(
          {
            shopId: { $in: sIds },
            $or: [
              { roNumber: roStr },
              { roNumber: Number(roStr) },
            ],
          },
          {
            $set: {
              primaryRefs: xref,
              primaryMatched: matched,
              primaryMatchedAt: new Date(),
            },
          }
        );
        if (updateRes.matchedCount === 0) {
          console.warn(
            `[autoflow-webhook] DVI cross-reference write missed dvi_results for shop ${sId} RO ${roStr} (snapshot may not have been written yet)`
          );
        }

        if (!matched) {
          console.log(
            `[autoflow-webhook] DVI for shop ${sId} RO ${roStr} (VIN ${vinForXref || "?"}) has no matching Tekmetric/Protractor/Shop-Ware work order`
          );
        }
      } catch (xerr: any) {
        console.warn(
          `[autoflow-webhook] DVI cross-reference failed for shop ${shop.shopId} RO ${roNumber}: ${xerr.message}`
        );
      }
    }
  } catch (e) {
    // Swallow normalization errors; raw event is still stored for replay
    console.error("Webhook normalization error:", e);
  }

  return NextResponse.json({ ok: true, shopId: shop.shopId });
}
