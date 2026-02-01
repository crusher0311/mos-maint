import Stripe from "stripe";
import sql from "@/lib/db/postgres";

let stripeInstance: Stripe | null = null;

export function getStripe(): Stripe {
  if (!stripeInstance) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error("STRIPE_SECRET_KEY is not configured");
    }
    stripeInstance = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2025-12-15.clover",
    });
  }
  return stripeInstance;
}

export const stripe = {
  get prices() {
    return getStripe().prices;
  },
  get products() {
    return getStripe().products;
  },
  get customers() {
    return getStripe().customers;
  },
  get subscriptions() {
    return getStripe().subscriptions;
  },
  get checkout() {
    return getStripe().checkout;
  },
  get billingPortal() {
    return getStripe().billingPortal;
  },
  get webhooks() {
    return getStripe().webhooks;
  },
};

export type VinPackConfig = {
  productId: string;
  priceId: string;
  vinCount: number;
  price: number;
};

export type BillingSettings = {
  starterProductId: string;
  starterPriceId: string;
  starterPrice: number;
  starterIncludedVins: number;
  plusProductId: string;
  plusPriceId: string;
  plusPrice: number;
  plusIncludedVins: number;
  eliteProductId: string;
  elitePriceId: string;
  elitePrice: number;
  eliteIncludedVins: number;
  mosProProductId: string;
  mosProPriceId: string;
  mosProPrice: number;
  mosProIncludedVins: number;
  vinPack100ProductId: string;
  vinPack100PriceId: string;
  vinPack100Price: number;
  vinPack250ProductId: string;
  vinPack250PriceId: string;
  vinPack250Price: number;
  vinPack500ProductId: string;
  vinPack500PriceId: string;
  vinPack500Price: number;
  onboardingProductId: string;
  onboardingPriceId: string;
  onboardingPrice: number;
  trialDays: number;
  trialVinLimit: number;
  defaultVinLimit: number;
  foundingShopPricing: boolean;
  skipTrialBonusVins: number;
};

const DEFAULT_BILLING_SETTINGS: BillingSettings = {
  starterProductId: "",
  starterPriceId: "",
  starterPrice: 199.95,
  starterIncludedVins: 300,
  plusProductId: "",
  plusPriceId: "",
  plusPrice: 229.95,
  plusIncludedVins: 300,
  eliteProductId: "",
  elitePriceId: "",
  elitePrice: 279.95,
  eliteIncludedVins: 300,
  mosProProductId: "",
  mosProPriceId: "",
  mosProPrice: 199,
  mosProIncludedVins: 300,
  vinPack100ProductId: "",
  vinPack100PriceId: "",
  vinPack100Price: 39,
  vinPack250ProductId: "",
  vinPack250PriceId: "",
  vinPack250Price: 79,
  vinPack500ProductId: "",
  vinPack500PriceId: "",
  vinPack500Price: 149,
  onboardingProductId: "",
  onboardingPriceId: "",
  onboardingPrice: 495,
  trialDays: 14,
  trialVinLimit: 10,
  defaultVinLimit: 300,
  foundingShopPricing: true,
  skipTrialBonusVins: 50,
};

export async function getBillingSettings(): Promise<BillingSettings> {
  try {
    const result = await sql`
      SELECT value FROM platform_settings WHERE key = 'billing' LIMIT 1
    `;
    
    if (result.length === 0) {
      return DEFAULT_BILLING_SETTINGS;
    }

    const settings = result[0].value || {};
    return {
      starterProductId: settings.starterProductId || "",
      starterPriceId: settings.starterPriceId || "",
      starterPrice: settings.starterPrice ?? 199.95,
      starterIncludedVins: settings.starterIncludedVins ?? 300,
      plusProductId: settings.plusProductId || "",
      plusPriceId: settings.plusPriceId || "",
      plusPrice: settings.plusPrice ?? 229.95,
      plusIncludedVins: settings.plusIncludedVins ?? 300,
      eliteProductId: settings.eliteProductId || "",
      elitePriceId: settings.elitePriceId || "",
      elitePrice: settings.elitePrice ?? 279.95,
      eliteIncludedVins: settings.eliteIncludedVins ?? 300,
      mosProProductId: settings.mosProProductId || "",
      mosProPriceId: settings.mosProPriceId || "",
      mosProPrice: settings.mosProPrice ?? 199,
      mosProIncludedVins: settings.mosProIncludedVins ?? 300,
      vinPack100ProductId: settings.vinPack100ProductId || "",
      vinPack100PriceId: settings.vinPack100PriceId || "",
      vinPack100Price: settings.vinPack100Price ?? 39,
      vinPack250ProductId: settings.vinPack250ProductId || "",
      vinPack250PriceId: settings.vinPack250PriceId || "",
      vinPack250Price: settings.vinPack250Price ?? 79,
      vinPack500ProductId: settings.vinPack500ProductId || "",
      vinPack500PriceId: settings.vinPack500PriceId || "",
      vinPack500Price: settings.vinPack500Price ?? 149,
      onboardingProductId: settings.onboardingProductId || "",
      onboardingPriceId: settings.onboardingPriceId || "",
      onboardingPrice: settings.onboardingPrice ?? 495,
      trialDays: settings.trialDays ?? 14,
      trialVinLimit: settings.trialVinLimit ?? 10,
      defaultVinLimit: settings.defaultVinLimit ?? 300,
      foundingShopPricing: settings.foundingShopPricing ?? true,
      skipTrialBonusVins: settings.skipTrialBonusVins ?? 50,
    };
  } catch (error) {
    console.error("Error loading billing settings:", error);
    return DEFAULT_BILLING_SETTINGS;
  }
}

export async function saveBillingSettings(settings: Partial<BillingSettings>): Promise<void> {
  const existingResult = await sql`
    SELECT value FROM platform_settings WHERE key = 'billing' LIMIT 1
  `;
  
  const existingValue = existingResult.length > 0 ? existingResult[0].value || {} : {};
  const mergedSettings = { ...existingValue, ...settings };
  
  await sql`
    INSERT INTO platform_settings (key, value)
    VALUES ('billing', ${JSON.stringify(mergedSettings)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET
      value = ${JSON.stringify(mergedSettings)}::jsonb,
      updated_at = NOW()
  `;
}

export function getBaseUrl() {
  if (process.env.REPLIT_DOMAINS) {
    const domains = process.env.REPLIT_DOMAINS.split(",");
    return `https://${domains[0]}`;
  }
  if (process.env.REPLIT_DEV_DOMAIN) {
    return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  }
  return "http://localhost:5000";
}
