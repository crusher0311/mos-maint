import { parseCarfaxPayload, upsertCarfaxSnapshot } from "@/lib/integrations/carfax";
import {
  claimPartnerCarfaxDelivery,
  executeOwnedPartnerCarfaxDelivery,
  findPartnerCarfaxDelivery,
  reclaimExpiredPartnerCarfaxDelivery,
  releasePartnerCarfaxDelivery,
} from "@/lib/data/repositories/partner-carfax-deliveries";

export const CARFAX_INGEST_MAX_BYTES = 512 * 1024;
export const CARFAX_INGEST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_DELIVERY_ID = 128;
const MAX_ARRAY_ITEMS = 2_000;
const MAX_STRING_LENGTH = 20_000;
const MAX_DEPTH = 16;

export type CarfaxIngestionBody = {
  vin: string;
  sms: string;
  smsShopId: string | number;
  deliveryId: string;
  retrievedAt: string;
  report: Record<string, unknown>;
};

export function validateCarfaxIngestionBody(
  value: unknown,
  now = new Date(),
): { ok: true; body: CarfaxIngestionBody; retrievedAt: Date } | { ok: false; error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "JSON body must be an object" };
  }
  const body = value as Record<string, unknown>;
  const vin = typeof body.vin === "string" ? body.vin.trim().toUpperCase() : "";
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
    return { ok: false, error: "vin must be a valid 17-character VIN" };
  }
  const sms = typeof body.sms === "string" ? body.sms.trim().toLowerCase() : "";
  if (!["live_api", "tekmetric", "shopware", "protractor", "autoflow", "shopmonkey"].includes(sms)) {
    return { ok: false, error: "sms must be one of: live_api, tekmetric, shopware, protractor, autoflow, shopmonkey" };
  }
  if (
    (typeof body.smsShopId !== "string" && typeof body.smsShopId !== "number") ||
    String(body.smsShopId).trim().length === 0
  ) {
    return { ok: false, error: "smsShopId is required" };
  }
  const deliveryId = typeof body.deliveryId === "string" ? body.deliveryId.trim() : "";
  if (!deliveryId || deliveryId.length > MAX_DELIVERY_ID) {
    return { ok: false, error: `deliveryId must be 1-${MAX_DELIVERY_ID} characters` };
  }
  const retrievedAt = new Date(typeof body.retrievedAt === "string" ? body.retrievedAt : "");
  if (!Number.isFinite(retrievedAt.getTime())) {
    return { ok: false, error: "retrievedAt must be a valid ISO-8601 timestamp" };
  }
  if (retrievedAt.getTime() > now.getTime() + MAX_FUTURE_SKEW_MS) {
    return { ok: false, error: "retrievedAt cannot be more than 5 minutes in the future" };
  }
  if (retrievedAt.getTime() < now.getTime() - CARFAX_INGEST_MAX_AGE_MS) {
    return { ok: false, error: "retrievedAt is too old; reports must be delivered within 7 days" };
  }
  if (!body.report || typeof body.report !== "object" || Array.isArray(body.report)) {
    return { ok: false, error: "report must be the original CARFAX JSON object" };
  }
  const boundsError = validateNestedBounds(body.report, 0);
  if (boundsError) return { ok: false, error: boundsError };
  return {
    ok: true,
    body: { vin, sms, smsShopId: body.smsShopId as string | number, deliveryId, retrievedAt: body.retrievedAt as string, report: body.report as Record<string, unknown> },
    retrievedAt,
  };
}

function validateNestedBounds(value: unknown, depth: number): string | null {
  if (depth > MAX_DEPTH) return `report nesting exceeds ${MAX_DEPTH} levels`;
  if (typeof value === "string" && value.length > MAX_STRING_LENGTH) {
    return `report strings cannot exceed ${MAX_STRING_LENGTH} characters`;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) return `report arrays cannot exceed ${MAX_ARRAY_ITEMS} items`;
    for (const item of value) {
      const error = validateNestedBounds(item, depth + 1);
      if (error) return error;
    }
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value)) {
      const error = validateNestedBounds(child, depth + 1);
      if (error) return error;
    }
  }
  return null;
}

export function normalizePartnerCarfaxReport(report: Record<string, unknown>, vin: string) {
  const root: any = (report as any).report || (report as any).data || report;
  const reportVin =
    root?.vin ||
    root?.vehicle?.vin ||
    root?.inputVin ||
    root?.serviceHistory?.vin;
  if (typeof reportVin !== "string" || !reportVin.trim()) {
    return { ok: false as const, error: "CARFAX report must contain its VIN" };
  }
  const normalized = parseCarfaxPayload(report, vin);
  if (!normalized.ok) return { ok: false as const, error: normalized.error ?? "CARFAX report contains an error" };
  if (String(normalized.vin ?? "").toUpperCase() !== vin) {
    return { ok: false as const, error: "VIN in CARFAX report does not match vin" };
  }
  const hasServiceShape =
    Array.isArray(root?.serviceHistory?.displayRecords) ||
    Array.isArray(root?.serviceHistory) ||
    Array.isArray(root?.serviceRecords) ||
    Array.isArray(root?.services);
  if (!hasServiceShape) {
    return { ok: false as const, error: "Unsupported CARFAX report shape: service history array required" };
  }
  const hasContent =
    (normalized.serviceRecords?.length ?? 0) > 0 ||
    (normalized.recallRecords?.length ?? 0) > 0;
  if (!hasContent) {
    return { ok: false as const, error: "CARFAX report contains no service or recall records" };
  }
  return { ok: true as const, normalized };
}

export async function ingestPartnerCarfaxReport(args: {
  partnerId: string;
  shopId: number;
  body: CarfaxIngestionBody;
  retrievedAt: Date;
}): Promise<
  | { ok: false; error: string }
  | { ok: true; duplicate: boolean; stored: boolean; outcome?: string }
> {
  const key = {
    partnerId: args.partnerId,
    shopId: args.shopId,
    deliveryId: args.body.deliveryId,
  };
  const existing = await findPartnerCarfaxDelivery(key);
  if (existing?.status === "completed") {
    return { ok: true, duplicate: true, stored: existing.stored !== false, outcome: existing.outcome };
  }

  const parsed = normalizePartnerCarfaxReport(args.body.report, args.body.vin);
  if (!parsed.ok) return parsed;

  const ownerToken = existing
    ? await reclaimExpiredPartnerCarfaxDelivery(key)
    : await claimPartnerCarfaxDelivery(
        key,
        { vin: args.body.vin, retrievedAt: args.retrievedAt },
      );
  if (!ownerToken) {
    return { ok: false, error: "This delivery is already being processed; retry shortly" };
  }

  try {
    const committed = await executeOwnedPartnerCarfaxDelivery(
      key,
      ownerToken,
      async (db, session) => {
        const result = await upsertCarfaxSnapshot(
          args.shopId,
          args.body.vin,
          parsed.normalized,
          {
            source: "partner",
            sourceRetrievedAt: args.retrievedAt,
            provenance: { partnerId: args.partnerId, deliveryId: args.body.deliveryId },
            db,
            session,
          },
        );
        const value = {
          ok: true as const,
          duplicate: false,
          stored: result?.written !== false,
          outcome: result?.reason,
        };
        return { stored: value.stored, outcome: value.outcome, value };
      },
    );
    if (!committed) {
      return { ok: false, error: "Delivery ownership expired; retry shortly" };
    }
    return committed;
  } catch (error) {
    await releasePartnerCarfaxDelivery(key, ownerToken).catch(() => {});
    const transactionError = error as any;
    if (
      transactionError?.code === 112 ||
      transactionError?.hasErrorLabel?.("TransientTransactionError") ||
      String(transactionError?.message || "").includes("ownership was lost")
    ) {
      return { ok: false, error: "Delivery ownership changed; retry shortly" };
    }
    throw error;
  }
}