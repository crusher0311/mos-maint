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
      SELECT * FROM platform_settings WHERE type = 'billing' LIMIT 1
    `;
    
    if (result.length === 0) {
      return DEFAULT_BILLING_SETTINGS;
    }

    const settings = result[0];
    return {
      starterProductId: settings.starter_product_id || "",
      starterPriceId: settings.starter_price_id || "",
      starterPrice: settings.starter_price ?? 199.95,
      starterIncludedVins: settings.starter_included_vins ?? 300,
      plusProductId: settings.plus_product_id || "",
      plusPriceId: settings.plus_price_id || "",
      plusPrice: settings.plus_price ?? 229.95,
      plusIncludedVins: settings.plus_included_vins ?? 300,
      eliteProductId: settings.elite_product_id || "",
      elitePriceId: settings.elite_price_id || "",
      elitePrice: settings.elite_price ?? 279.95,
      eliteIncludedVins: settings.elite_included_vins ?? 300,
      mosProProductId: settings.mos_pro_product_id || "",
      mosProPriceId: settings.mos_pro_price_id || "",
      mosProPrice: settings.mos_pro_price ?? 199,
      mosProIncludedVins: settings.mos_pro_included_vins ?? 300,
      vinPack100ProductId: settings.vin_pack_100_product_id || "",
      vinPack100PriceId: settings.vin_pack_100_price_id || "",
      vinPack100Price: settings.vin_pack_100_price ?? 39,
      vinPack250ProductId: settings.vin_pack_250_product_id || "",
      vinPack250PriceId: settings.vin_pack_250_price_id || "",
      vinPack250Price: settings.vin_pack_250_price ?? 79,
      vinPack500ProductId: settings.vin_pack_500_product_id || "",
      vinPack500PriceId: settings.vin_pack_500_price_id || "",
      vinPack500Price: settings.vin_pack_500_price ?? 149,
      onboardingProductId: settings.onboarding_product_id || "",
      onboardingPriceId: settings.onboarding_price_id || "",
      onboardingPrice: settings.onboarding_price ?? 495,
      trialDays: settings.trial_days ?? 14,
      trialVinLimit: settings.trial_vin_limit ?? 10,
      defaultVinLimit: settings.default_vin_limit ?? 300,
      foundingShopPricing: settings.founding_shop_pricing ?? true,
      skipTrialBonusVins: settings.skip_trial_bonus_vins ?? 50,
    };
  } catch (error) {
    console.error("Error loading billing settings:", error);
    return DEFAULT_BILLING_SETTINGS;
  }
}

export async function saveBillingSettings(settings: Partial<BillingSettings>): Promise<void> {
  const updateData: Record<string, unknown> = { type: "billing" };
  
  if (settings.starterProductId !== undefined) updateData.starter_product_id = settings.starterProductId;
  if (settings.starterPriceId !== undefined) updateData.starter_price_id = settings.starterPriceId;
  if (settings.starterPrice !== undefined) updateData.starter_price = settings.starterPrice;
  if (settings.starterIncludedVins !== undefined) updateData.starter_included_vins = settings.starterIncludedVins;
  if (settings.plusProductId !== undefined) updateData.plus_product_id = settings.plusProductId;
  if (settings.plusPriceId !== undefined) updateData.plus_price_id = settings.plusPriceId;
  if (settings.plusPrice !== undefined) updateData.plus_price = settings.plusPrice;
  if (settings.plusIncludedVins !== undefined) updateData.plus_included_vins = settings.plusIncludedVins;
  if (settings.eliteProductId !== undefined) updateData.elite_product_id = settings.eliteProductId;
  if (settings.elitePriceId !== undefined) updateData.elite_price_id = settings.elitePriceId;
  if (settings.elitePrice !== undefined) updateData.elite_price = settings.elitePrice;
  if (settings.eliteIncludedVins !== undefined) updateData.elite_included_vins = settings.eliteIncludedVins;
  if (settings.mosProProductId !== undefined) updateData.mos_pro_product_id = settings.mosProProductId;
  if (settings.mosProPriceId !== undefined) updateData.mos_pro_price_id = settings.mosProPriceId;
  if (settings.mosProPrice !== undefined) updateData.mos_pro_price = settings.mosProPrice;
  if (settings.mosProIncludedVins !== undefined) updateData.mos_pro_included_vins = settings.mosProIncludedVins;
  if (settings.vinPack100ProductId !== undefined) updateData.vin_pack_100_product_id = settings.vinPack100ProductId;
  if (settings.vinPack100PriceId !== undefined) updateData.vin_pack_100_price_id = settings.vinPack100PriceId;
  if (settings.vinPack100Price !== undefined) updateData.vin_pack_100_price = settings.vinPack100Price;
  if (settings.vinPack250ProductId !== undefined) updateData.vin_pack_250_product_id = settings.vinPack250ProductId;
  if (settings.vinPack250PriceId !== undefined) updateData.vin_pack_250_price_id = settings.vinPack250PriceId;
  if (settings.vinPack250Price !== undefined) updateData.vin_pack_250_price = settings.vinPack250Price;
  if (settings.vinPack500ProductId !== undefined) updateData.vin_pack_500_product_id = settings.vinPack500ProductId;
  if (settings.vinPack500PriceId !== undefined) updateData.vin_pack_500_price_id = settings.vinPack500PriceId;
  if (settings.vinPack500Price !== undefined) updateData.vin_pack_500_price = settings.vinPack500Price;
  if (settings.onboardingProductId !== undefined) updateData.onboarding_product_id = settings.onboardingProductId;
  if (settings.onboardingPriceId !== undefined) updateData.onboarding_price_id = settings.onboardingPriceId;
  if (settings.onboardingPrice !== undefined) updateData.onboarding_price = settings.onboardingPrice;
  if (settings.trialDays !== undefined) updateData.trial_days = settings.trialDays;
  if (settings.trialVinLimit !== undefined) updateData.trial_vin_limit = settings.trialVinLimit;
  if (settings.defaultVinLimit !== undefined) updateData.default_vin_limit = settings.defaultVinLimit;
  if (settings.foundingShopPricing !== undefined) updateData.founding_shop_pricing = settings.foundingShopPricing;
  if (settings.skipTrialBonusVins !== undefined) updateData.skip_trial_bonus_vins = settings.skipTrialBonusVins;
  
  await sql`
    INSERT INTO platform_settings ${sql(updateData)}
    ON CONFLICT (type) DO UPDATE SET ${sql(updateData)}, updated_at = NOW()
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
