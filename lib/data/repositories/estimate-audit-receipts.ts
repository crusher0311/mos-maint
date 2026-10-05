import { getDb } from "@/lib/mongo";
import {
  auditAutomationEnabled,
  scheduleAuditFromReceipt,
  type AuditAutomationInput,
  type AuditProvider,
  type AuditReceiptSource,
} from "@/lib/estimate-assist/audit-automation";
import { scheduleAuditReceiptForNormalizedPayload } from "@/lib/integrations/core/normalized-ingestion";
import type { ShopWareRepairOrder } from "@/lib/integrations/shopware/types";

/**
 * Repository boundary for asynchronous audit-receipt handoffs made from
 * provider routes and adapters. It keeps database acquisition out of those
 * transport layers and preserves the inexpensive opt-in gate before Mongo is
 * touched.
 */
export async function scheduleAuditReceipt(
  input: AuditAutomationInput,
): Promise<void> {
  if (!auditAutomationEnabled(input.shopId)) return;
  const db = await getDb();
  await scheduleAuditFromReceipt(db, input);
}

export async function scheduleNormalizedAuditReceipt(
  shopId: number,
  provider: Exclude<AuditProvider, "shopware">,
  sourceData: unknown,
  source: AuditReceiptSource,
  enterpriseId?: string,
): Promise<void> {
  if (!auditAutomationEnabled(shopId)) return;
  const db = await getDb();
  await scheduleAuditReceiptForNormalizedPayload(
    db,
    shopId,
    provider,
    sourceData,
    source,
    enterpriseId,
  );
}

/**
 * Shop-Ware exposes the same detail shape in webhook, cron, and adapter paths.
 * Keep receipt mapping here so all paths hash the same audit-relevant values.
 * A non-empty service collection must include both requested nested
 * associations; otherwise it is a sparse projection, not a complete ticket.
 */
export function buildShopwareAuditReceipt(
  shopId: number,
  ro: ShopWareRepairOrder,
  source: AuditReceiptSource,
): AuditAutomationInput | null {
  if (
    !Array.isArray(ro.services) ||
    !ro.services.every(
      (service) => Array.isArray(service.labors) && Array.isArray(service.parts),
    )
  ) {
    return null;
  }

  const lineItems = ro.services
    .map((service) => {
      const laborHours = service.labors.reduce(
        (total, labor) => total + (Number(labor.hours) || 0),
        0,
      );
      const laborTotal =
        service.is_fixed_price_service && service.fixed_price_labor_total_cents != null
          ? service.fixed_price_labor_total_cents / 100
          : service.labor_rate_cents != null
            ? (laborHours * service.labor_rate_cents) / 100
            : 0;
      const partsTotal = service.parts.reduce(
        (total, part) =>
          total + ((Number(part.sell_price_cents) || 0) / 100) * (Number(part.quantity) || 0),
        0,
      );
      const subletsTotal = (service.sublets || []).reduce(
        (total, sublet) => total + (Number(sublet.price_cents) || 0) / 100,
        0,
      );
      const hazmatsTotal = (service.hazmats || []).reduce(
        (total, hazmat) =>
          total + ((Number(hazmat.fee_cents) || 0) / 100) * (Number(hazmat.quantity) || 0),
        0,
      );

      return {
        title: service.title || `Service ${service.id}`,
        description: service.comment ?? undefined,
        type: service.category_id != null ? String(service.category_id) : undefined,
        laborHours,
        laborTotal,
        partsTotal,
        parts: service.parts.map((part) => ({
          description: part.description,
          quantity: Number(part.quantity) || 0,
          unitPrice: (Number(part.sell_price_cents) || 0) / 100,
        })),
        total:
          service.fixed_price_cents != null
            ? service.fixed_price_cents / 100
            : laborTotal + partsTotal + subletsTotal + hazmatsTotal,
      };
    })
    .filter((item) => item.title);

  return {
    shopId,
    provider: "shopware",
    workOrderId: String(ro.id),
    workOrderNumber: ro.number != null ? String(ro.number) : undefined,
    smsWorkOrderId: String(ro.id),
    lineItems,
    vehicleInfo: {
      vin: ro.vehicle?.vin?.toUpperCase(),
      year: ro.vehicle?.year ? Number(ro.vehicle.year) : undefined,
      make: ro.vehicle?.make,
      model: ro.vehicle?.model,
      mileage: ro.odometer ?? undefined,
    },
    vehicleVin: ro.vehicle?.vin?.toUpperCase() ?? null,
    canUseMaintenance: false,
    completeTicket: true,
    source,
    upstreamUpdatedAt: ro.updated_at ?? null,
  };
}

export async function scheduleShopwareAuditReceipt(
  shopId: number,
  ro: ShopWareRepairOrder,
  source: AuditReceiptSource,
): Promise<void> {
  // Gate before mapping so disabled shops do no receipt work.
  if (!auditAutomationEnabled(shopId)) return;
  const receipt = buildShopwareAuditReceipt(shopId, ro, source);
  if (!receipt) return;
  await scheduleAuditReceipt(receipt);
}