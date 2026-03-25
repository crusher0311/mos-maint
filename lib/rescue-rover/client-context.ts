import { getDb as getMongoDb } from "@/lib/mongo";
import type { ClientContext } from "./types";

export async function lookupClientByPhone(
  phone: string,
  shopId: number,
): Promise<ClientContext | null> {
  try {
    const db = await getMongoDb();
    const normalizedPhone = normalizePhone(phone);
    const phoneVariants = buildPhoneVariants(normalizedPhone);

    const user = await db.collection("users").findOne({
      $or: [
        { phone: { $in: phoneVariants } },
        { mobilePhone: { $in: phoneVariants } },
        { workPhone: { $in: phoneVariants } },
      ],
    });

    let resolvedShopId = shopId;
    let shopName: string | null = null;
    let contactName: string | null = null;
    let contactEmail: string | null = null;

    if (user) {
      contactName =
        user.name ||
        [user.firstName, user.lastName].filter(Boolean).join(" ") ||
        null;
      contactEmail = user.email || user.emailLower || null;

      if (user.shopIds && user.shopIds.length > 0) {
        resolvedShopId = Number(user.shopIds[0]);
      } else if (user.shopId) {
        resolvedShopId = Number(user.shopId);
      }
    }

    const shop = await db.collection("shops").findOne({
      shopId: { $in: [resolvedShopId, String(resolvedShopId)] },
    });

    if (!shop) {
      return {
        shopId: resolvedShopId,
        shopName: null,
        contactName,
        email: contactEmail,
        phone: normalizedPhone,
        billing: { status: "unknown", plan: null, stripeCustomerId: null },
        integrations: {
          protractor: false,
          tekmetric: false,
          shopware: false,
          autoflow: false,
          carfax: false,
          smsProvider: null,
        },
        enabledFeatures: [],
        vehicleCount: 0,
        lastActivity: null,
        openTickets: 0,
      };
    }

    shopName = shop.name || `Shop ${resolvedShopId}`;

    const billingStatus =
      shop.billing?.status || shop.billing?.plan || "trial";
    const billingPlan = shop.billing?.plan || null;
    const stripeCustomerId = shop.billing?.stripeCustomerId || null;

    const integrations = {
      protractor: !!(
        shop.protractor?.configured ||
        shop.protractor?.apiKey ||
        shop.protractorApiKey ||
        shop.protractorConnectionId
      ),
      tekmetric: !!(shop.tekmetric?.shopId || shop.tekmetricShopId),
      shopware: !!(shop.shopware?.tenantId),
      autoflow: !!(
        shop.autoflow?.apiKey ||
        shop.autoflow?.configured ||
        shop.autoflowApiKey
      ),
      carfax: !!(
        shop.carfax?.locationId ||
        shop.carfax?.serviceId ||
        shop.carfaxLocationId
      ),
      smsProvider: (shop.smsProvider as string) || null,
    };

    const enabledFeatures: string[] = [];
    const featureMap: Record<string, string> = {
      maintenance: "Maintenance Planning",
      job_lookup: "Job Lookup",
      common_failures: "Common Failures Advisor",
      oil_sticker: "Oil Sticker",
      keytags: "Key Tags",
      auto_booking: "Auto Booking",
      part_xref: "Part Cross-Reference",
      labor_rates: "Labor Rates",
      concern_assistant: "Customer Concern Assistant",
    };
    if (shop.enabledFeatures) {
      for (const [key, label] of Object.entries(featureMap)) {
        if (shop.enabledFeatures[key]) {
          enabledFeatures.push(label);
        }
      }
    }

    const vehicleCount = await db
      .collection("vehicles")
      .countDocuments({
        shopId: { $in: [resolvedShopId, String(resolvedShopId)] },
      });

    const openTickets = await db
      .collection("support_tickets")
      .countDocuments({
        shopId: { $in: [resolvedShopId, String(resolvedShopId)] },
        status: { $in: ["open", "in_progress", "pending"] },
      });

    const lastEvent = await db
      .collection("api_usage")
      .findOne(
        { shopId: { $in: [resolvedShopId, String(resolvedShopId)] } },
        { sort: { createdAt: -1 } },
      );

    return {
      shopId: resolvedShopId,
      shopName,
      contactName,
      email: contactEmail,
      phone: normalizedPhone,
      billing: {
        status: billingStatus,
        plan: billingPlan,
        stripeCustomerId,
      },
      integrations,
      enabledFeatures,
      vehicleCount,
      lastActivity: lastEvent?.createdAt || null,
      openTickets,
    };
  } catch (err) {
    console.error("[RescueRover] Client lookup error:", err);
    return null;
  }
}

export function buildClientContextPrompt(ctx: ClientContext | null): string {
  if (!ctx) {
    return "\n## CALLER INFO\nNo client record found for this phone number. This may be a new or unrecognized caller.\n";
  }

  const lines = ["\n## CLIENT INFO"];
  if (ctx.contactName) lines.push(`Contact: ${ctx.contactName}`);
  if (ctx.email) lines.push(`Email: ${ctx.email}`);
  lines.push(`Phone: ${ctx.phone}`);
  lines.push(`Shop ID: ${ctx.shopId}`);
  if (ctx.shopName) lines.push(`Shop Name: ${ctx.shopName}`);

  lines.push(`\n### Account`);
  lines.push(`Billing Status: ${ctx.billing.status}`);
  if (ctx.billing.plan) lines.push(`Plan: ${ctx.billing.plan}`);
  lines.push(`Vehicles in System: ${ctx.vehicleCount}`);
  if (ctx.lastActivity) {
    const daysSince = Math.round(
      (Date.now() - new Date(ctx.lastActivity).getTime()) / (1000 * 60 * 60 * 24),
    );
    lines.push(`Last Activity: ${daysSince === 0 ? "Today" : `${daysSince} day(s) ago`}`);
  }
  lines.push(`Open Support Tickets: ${ctx.openTickets}`);

  lines.push(`\n### Integrations`);
  const connectedIntegrations: string[] = [];
  if (ctx.integrations.protractor) connectedIntegrations.push("Protractor");
  if (ctx.integrations.tekmetric) connectedIntegrations.push("Tekmetric");
  if (ctx.integrations.shopware) connectedIntegrations.push("Shop-Ware");
  if (ctx.integrations.autoflow) connectedIntegrations.push("AutoFlow");
  if (ctx.integrations.carfax) connectedIntegrations.push("CARFAX");
  lines.push(
    connectedIntegrations.length > 0
      ? `Connected: ${connectedIntegrations.join(", ")}`
      : "No integrations connected",
  );
  if (ctx.integrations.smsProvider) {
    lines.push(`SMS Provider: ${ctx.integrations.smsProvider}`);
  }

  if (ctx.enabledFeatures.length > 0) {
    lines.push(`\n### Enabled Features`);
    lines.push(ctx.enabledFeatures.join(", "));
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
    variants.push(
      `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`,
    );
  }
  return variants;
}
