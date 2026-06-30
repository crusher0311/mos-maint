// app/api/webhooks/autoflow/route.ts
//
// Single-source AutoFlow webhook receiver. ONE URL for every shop/location:
//   https://mos.tools/api/webhooks/autoflow
// The shop is resolved on the backend from the payload's `shop` object
// (primarily `shop.domain` -> stored `autoflowDomain`), the same way the
// Tekmetric webhook resolves the shop from `repairOrder.shopId`. This removes
// the need for a per-shop token URL when a customer has many locations.
//
// The legacy per-shop token URL (./[token]/route.ts) still works for anything
// already configured. Shared processing lives in lib/integrations/autoflow/webhook.ts.
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/mongo";
import {
  verifyHmacSHA256,
  processAutoflowWebhookEvent,
  resolveShopFromAutoflowPayload,
  extractAutoflowDomain,
} from "@/lib/integrations/autoflow/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---- GET: health/ping ---------------------------------------------------

export async function GET() {
  return NextResponse.json({ ok: true, mode: "single-source" });
}

// ---- POST: accept webhook (shop resolved from payload) ------------------

export async function POST(req: NextRequest) {
  const raw = await req.text();
  let payload: any = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    // keep payload as null; raw is still captured below
  }

  // OPTIONAL signature verification (enable by setting AUTOFLOW_SIGNING_SECRET).
  // With a single-source URL there is no per-shop token acting as a shared
  // secret, so enabling this is the recommended way to authenticate AutoFlow.
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
  const shop = await resolveShopFromAutoflowPayload(db, payload);

  if (!shop) {
    const domain = extractAutoflowDomain(payload);
    console.warn(
      `[autoflow-webhook] single-source: could not resolve shop for domain=${domain || "(none)"} shop=${JSON.stringify(payload?.shop ?? null)} — storing for diagnostics`
    );
    // Capture the unresolved event so it can be inspected/replayed once the
    // shop's autoflowDomain is corrected. Return 200 so AutoFlow doesn't
    // retry-storm; the payload is safely persisted.
    try {
      await db.collection("autoflow_unresolved_events").insertOne({
        domain: domain || null,
        shopHint: payload?.shop ?? null,
        event: payload?.event ?? null,
        raw,
        receivedAt: new Date(),
      });
    } catch {
      // best-effort diagnostics only
    }
    return NextResponse.json({ ok: true, resolved: false }, { status: 200 });
  }

  await processAutoflowWebhookEvent({ db, shop, token: null, raw, payload });

  return NextResponse.json({ ok: true, shopId: shop.shopId, resolved: true });
}
