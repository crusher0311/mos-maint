import { NextRequest, NextResponse } from "next/server";
import { createExternalEndpoint } from "@/lib/external-api/middleware";
import {
  CARFAX_INGEST_MAX_BYTES,
  ingestPartnerCarfaxReport,
  validateCarfaxIngestionBody,
} from "@/lib/external-api/carfax-ingestion";
import {
  AppFueledMappingValidationError,
  resolveActiveAppFueledMapping,
} from "@/lib/data/repositories/appfueled-shop-mappings";
import { buildPartnerVhiResponse } from "@/lib/external-api/partner-vhi-service";
import { withUpstreamTimeout } from "@/lib/with-upstream-timeout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const PARTNER_VHI_RESPONSE_TIMEOUT_MS = 30_000;

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
  async (req: NextRequest, { apiKey, isPartner, partnerId, requestId }) => {
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
    if (body.sms !== "live_api") {
      return NextResponse.json(
        { error: 'AppFueled CARFAX requests must use sms: "live_api"', requestId },
        { status: 400 },
      );
    }
    let shop;
    try {
      shop = await resolveActiveAppFueledMapping(String(body.smsShopId));
    } catch (error) {
      if (error instanceof AppFueledMappingValidationError) {
        return NextResponse.json({ error: error.message, requestId }, { status: 409 });
      }
      throw error;
    }
    if (!shop) {
      return NextResponse.json(
        { error: `No active AppFueled live_api mapping for external shop ID: ${body.smsShopId}`, requestId },
        { status: 404 },
      );
    }
    const result = await ingestPartnerCarfaxReport({
      partnerId,
      shopId: shop.mosShopId,
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
    const ingestion = {
      success: true as const,
      deliveryId: body.deliveryId,
      vin: body.vin,
      shopId: shop.mosShopId,
      duplicate: result.duplicate,
      stored: result.stored,
      outcome: result.outcome ?? (result.stored ? "stored" : "newer_snapshot_exists"),
      retrievedAt: retrievedAt.toISOString(),
    };
    console.log(
      `[PartnerCarfaxIngest] requestId=${requestId} partnerId=${partnerId} shopId=${shop.mosShopId} ` +
      `vin=${body.vin} deliveryId=${body.deliveryId} duplicate=${result.duplicate} stored=${result.stored}`,
    );
    let vhiResponse: NextResponse;
    let vhi: any;
    try {
      vhiResponse = await withUpstreamTimeout(
        buildPartnerVhiResponse(req, {
          apiKey,
          shopId: shop.mosShopId,
          isPartner: true,
          partnerId,
          requestId,
        }, {
          vin: body.vin,
          shopId: shop.mosShopId,
          mode: "full",
        }).catch((error) => {
          console.error(`[PartnerCarfaxIngest] VHI service error requestId=${requestId}:`, error);
          return NextResponse.json({
            success: false,
            error: "VHI service temporarily unavailable",
          }, { status: 503 });
        }),
        PARTNER_VHI_RESPONSE_TIMEOUT_MS,
        `AppFueled VHI ${body.vin}`,
        null as unknown as NextResponse,
      );
      if (!vhiResponse) {
        return NextResponse.json({
          ...ingestion,
          success: true,
          requestId,
          ingestion,
          vhi: {
            success: false,
            retryable: true,
            status: "deadline_exceeded",
            requestId,
            message: "CARFAX ingestion succeeded, but VHI exceeded its response deadline",
          },
          retryAfter: 5,
        }, { status: 202, headers: { "Retry-After": "5" } });
      }
      vhi = await vhiResponse.json();
    } catch (error) {
      console.error(`[PartnerCarfaxIngest] VHI failed after committed ingestion requestId=${requestId}:`, error);
      return NextResponse.json({
        ...ingestion,
        success: true,
        requestId,
        ingestion,
        vhi: {
          success: false,
          retryable: true,
          status: "temporarily_unavailable",
          requestId,
          message: "CARFAX ingestion succeeded, but VHI is temporarily unavailable",
        },
        retryAfter: 5,
      }, { status: 202, headers: { "Retry-After": "5" } });
    }
    if (vhiResponse.status >= 200 && vhiResponse.status < 300 && vhi?.success) {
      return NextResponse.json({ ...ingestion, requestId, ingestion, vhi });
    }
    const retryable = vhiResponse.status === 202 ||
      vhiResponse.status === 408 ||
      vhiResponse.status === 429 ||
      vhiResponse.status >= 500;
    if (!retryable) {
      return NextResponse.json({
        ...ingestion,
        success: true,
        requestId,
        ingestion,
        vhi: {
          success: false,
          retryable: false,
          status: "permanently_unavailable",
          httpStatus: vhiResponse.status,
          requestId,
          message: vhi?.message || vhi?.error || "VHI cannot be built for this vehicle",
        },
      });
    }
    const retryAfter = Number(vhiResponse.headers.get("retry-after") || 5);
    return NextResponse.json({
      ...ingestion,
      success: true,
      requestId,
      ingestion,
      vhi: {
        success: false,
        retryable: true,
        status: vhi?.building ? "building" : "temporarily_unavailable",
        requestId,
        message: vhi?.message || vhi?.error || "VHI is not ready; retry this delivery",
      },
      retryAfter,
    }, { status: 202, headers: { "Retry-After": String(retryAfter) } });
  },
);