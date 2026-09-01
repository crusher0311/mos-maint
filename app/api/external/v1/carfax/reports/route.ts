import { NextRequest, NextResponse } from "next/server";
import { createExternalEndpoint } from "@/lib/external-api/middleware";
import { findShopBySmsId } from "@/lib/extension-shop-lookup";
import {
  CARFAX_INGEST_MAX_BYTES,
  ingestPartnerCarfaxReport,
  validateCarfaxIngestionBody,
} from "@/lib/external-api/carfax-ingestion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function readBoundedBody(req: NextRequest): Promise<
  | { ok: true; text: string }
  | { ok: false; tooLarge: boolean }
> {
  if (!req.body) return { ok: true, text: "" };
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > CARFAX_INGEST_MAX_BYTES) {
      await reader.cancel();
      return { ok: false, tooLarge: true };
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { ok: true, text };
}

export const POST = createExternalEndpoint(
  "carfax:write",
  async (req: NextRequest, { isPartner, partnerId, requestId }) => {
    if (!isPartner || partnerId?.toLowerCase() !== "appfueled") {
      return NextResponse.json({ error: "AppFueled partner API key required", requestId }, { status: 403 });
    }
    const declaredLength = Number(req.headers.get("content-length") || 0);
    if (declaredLength > CARFAX_INGEST_MAX_BYTES) {
      return NextResponse.json({ error: `Request body exceeds ${CARFAX_INGEST_MAX_BYTES} bytes`, requestId }, { status: 413 });
    }
    const bodyRead = await readBoundedBody(req);
    if (!bodyRead.ok) {
      return NextResponse.json({ error: `Request body exceeds ${CARFAX_INGEST_MAX_BYTES} bytes`, requestId }, { status: 413 });
    }
    const text = bodyRead.text;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "Malformed JSON body", requestId }, { status: 400 });
    }
    const validation = validateCarfaxIngestionBody(json);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error, requestId }, { status: 400 });
    }
    const { body, retrievedAt } = validation;
    const shop = await findShopBySmsId(String(body.smsShopId), {
      isPlatformAdmin: true,
      providerHint: body.sms,
    });
    if (!shop) {
      return NextResponse.json({ error: `No shop found for ${body.sms} ID: ${body.smsShopId}`, requestId }, { status: 404 });
    }
    if (shop.provider !== body.sms) {
      return NextResponse.json(
        { error: `Shop identifier resolved to ${shop.provider}, not ${body.sms}`, requestId },
        { status: 404 },
      );
    }
    const result = await ingestPartnerCarfaxReport({
      partnerId,
      shopId: Number(shop.mosShopId),
      body,
      retrievedAt,
    });
    if (!result.ok) {
      const retryable = result.error.includes("retry shortly");
      return NextResponse.json(
        { error: result.error, requestId, ...(retryable ? { retryAfter: 2 } : {}) },
        { status: retryable ? 409 : 422, headers: retryable ? { "Retry-After": "2" } : undefined },
      );
    }
    console.log(
      `[PartnerCarfaxIngest] requestId=${requestId} partnerId=${partnerId} shopId=${shop.mosShopId} ` +
      `vin=${body.vin} deliveryId=${body.deliveryId} duplicate=${result.duplicate} stored=${result.stored}`,
    );
    return NextResponse.json({
      success: true,
      requestId,
      deliveryId: body.deliveryId,
      vin: body.vin,
      shopId: Number(shop.mosShopId),
      duplicate: result.duplicate,
      stored: result.stored,
      retrievedAt: retrievedAt.toISOString(),
    });
  },
);