import { getDb as getMongoDb } from "@/lib/mongo";
import { getVhiFromAnalysisCache } from "@/lib/vhi-score";
import type { CustomerContext, VehicleContext } from "./types";

export async function lookupCustomerByPhone(
  phone: string,
  shopId: number,
): Promise<CustomerContext | null> {
  try {
    const db = await getMongoDb();

    const normalizedPhone = normalizePhone(phone);
    const phoneVariants = buildPhoneVariants(normalizedPhone);

    const customer = await db.collection("customers").findOne({
      shopId: { $in: [String(shopId), Number(shopId)] },
      $or: [
        { phone: { $in: phoneVariants } },
        { mobilePhone: { $in: phoneVariants } },
        { homePhone: { $in: phoneVariants } },
        { workPhone: { $in: phoneVariants } },
      ],
    });

    if (!customer) return null;

    const vehicles = await db
      .collection("vehicles")
      .find({
        shopId: { $in: [String(shopId), Number(shopId)] },
        $or: [
          { customerId: customer._id },
          { customerId: String(customer._id) },
          { customerName: customer.name },
        ],
      })
      .limit(10)
      .toArray();

    const vehicleContexts: VehicleContext[] = [];
    for (const v of vehicles) {
      if (!v.vin) continue;

      let vhiData = null;
      try {
        vhiData = await getVhiFromAnalysisCache(
          db,
          v.vin,
          shopId,
          v.currentMileage ?? null,
        );
      } catch {
        // VHI data optional
      }

      vehicleContexts.push({
        vin: v.vin,
        year: v.year ?? null,
        make: v.make ?? null,
        model: v.model ?? null,
        vhiScore: vhiData?.score?.value ?? null,
        vhiTier: vhiData?.score?.tier ?? null,
        overdueItems:
          vhiData?.buckets?.overdue?.map((i: any) => i.title) ?? [],
        dueSoonItems:
          vhiData?.buckets?.dueSoon?.map((i: any) => i.title) ?? [],
      });
    }

    return {
      name:
        customer.name ||
        [customer.firstName, customer.lastName].filter(Boolean).join(" ") ||
        null,
      phone: normalizedPhone,
      vehicles: vehicleContexts,
    };
  } catch (err) {
    console.error("[RescueRover] Customer lookup error:", err);
    return null;
  }
}

export function buildCustomerContextPrompt(
  ctx: CustomerContext | null,
): string {
  if (!ctx) {
    return "\n## CALLER INFO\nNo customer record found for this phone number. This may be a new customer.\n";
  }

  const lines = ["\n## CALLER INFO"];
  if (ctx.name) lines.push(`Customer Name: ${ctx.name}`);
  lines.push(`Phone: ${ctx.phone}`);

  if (ctx.vehicles.length > 0) {
    lines.push(`\nVehicles on file: ${ctx.vehicles.length}`);
    for (const v of ctx.vehicles) {
      const label = [v.year, v.make, v.model].filter(Boolean).join(" ");
      lines.push(`\n### ${label || "Unknown Vehicle"} (VIN: ${v.vin})`);
      if (v.vhiScore !== null) {
        lines.push(
          `- Vehicle Health Score: ${v.vhiScore}/100 (${v.vhiTier || "Unknown"})`,
        );
      }
      if (v.overdueItems.length > 0) {
        lines.push(
          `- OVERDUE maintenance: ${v.overdueItems.join(", ")}`,
        );
      }
      if (v.dueSoonItems.length > 0) {
        lines.push(`- Due soon: ${v.dueSoonItems.join(", ")}`);
      }
    }
  } else {
    lines.push("No vehicles on file.");
  }

  return lines.join("\n") + "\n";
}

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return digits.substring(1);
  }
  return digits;
}

function buildPhoneVariants(digits: string): string[] {
  const variants = [digits, `+1${digits}`, `1${digits}`];
  if (digits.length === 10) {
    const formatted = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    variants.push(formatted);
    variants.push(`${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`);
  }
  return variants;
}
