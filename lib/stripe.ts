import Stripe from "stripe";
import { getDb } from "@/lib/mongo";
import {
  DEFAULT_TRIAL_REMINDER_SUBJECT,
  DEFAULT_TRIAL_REMINDER_HTML,
  DEFAULT_TRIAL_REMINDER_TEXT,
} from "@/lib/email";

// Default schedule the trial-check cron has used historically. Admins can
// override this list from the billing settings page.
export const DEFAULT_TRIAL_REMINDER_DAYS: number[] = [7, 3, 1];

/**
 * Coerce an arbitrary value into a clean, sorted-descending list of unique
 * positive integer reminder days. Used by both the cron and the settings
 * save endpoint so junk like ["7", "3.4", -1, "abc"] turns into [7, 3].
 */
export function sanitizeTrialReminderDays(input: unknown): number[] {
  if (!Array.isArray(input)) return [...DEFAULT_TRIAL_REMINDER_DAYS];
  const cleaned = new Set<number>();
  for (const raw of input) {
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n)) continue;
    const intN = Math.trunc(n);
    if (intN > 0) cleaned.add(intN);
  }
  if (cleaned.size === 0) return [...DEFAULT_TRIAL_REMINDER_DAYS];
  return Array.from(cleaned).sort((a, b) => b - a);
}

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
  get setupIntents() {
    return getStripe().setupIntents;
  },
  get paymentMethods() {
    return getStripe().paymentMethods;
  },
};

export type VinPackConfig = {
  productId: string;
  priceId: string;
  vinCount: number;
  price: number;
};

export type BillingSettings = {
  // Tier-specific pricing (Starter, Plus, Elite)
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
  detectDogFounderProductId: string;
  detectDogFounderPriceId: string;
  detectDogFounderPrice: number;
  detectDogFounderIncludedVins: number;
  // Legacy mosPro fields (for backward compatibility)
  mosProProductId: string;
  mosProPriceId: string;
  mosProPrice: number;
  mosProIncludedVins: number;
  // VIN packs
  vinPack100ProductId: string;
  vinPack100PriceId: string;
  vinPack100Price: number;
  vinPack250ProductId: string;
  vinPack250PriceId: string;
  vinPack250Price: number;
  vinPack500ProductId: string;
  vinPack500PriceId: string;
  vinPack500Price: number;
  // Onboarding
  onboardingProductId: string;
  onboardingPriceId: string;
  onboardingPrice: number;
  // Trial settings
  trialDays: number;
  trialVinLimit: number;
  defaultVinLimit: number;
  foundingShopPricing: boolean;
  skipTrialBonusVins: number;
  // Trial reminder cron config (admin-tunable)
  trialReminderDays: number[];
  trialReminderSubject: string;
  trialReminderHtml: string;
  trialReminderText: string;
};

const DEFAULT_BILLING_SETTINGS: BillingSettings = {
  // Tier-specific pricing
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
  detectDogFounderProductId: "prod_UPkRVM5SeF3RiT",
  detectDogFounderPriceId: "",
  detectDogFounderPrice: 229.95,
  detectDogFounderIncludedVins: 300,
  // Legacy mosPro fields
  mosProProductId: "",
  mosProPriceId: "",
  mosProPrice: 199,
  mosProIncludedVins: 300,
  // VIN packs
  vinPack100ProductId: "",
  vinPack100PriceId: "",
  vinPack100Price: 39,
  vinPack250ProductId: "",
  vinPack250PriceId: "",
  vinPack250Price: 79,
  vinPack500ProductId: "",
  vinPack500PriceId: "",
  vinPack500Price: 149,
  // Onboarding
  onboardingProductId: "",
  onboardingPriceId: "",
  onboardingPrice: 495,
  // Trial settings
  trialDays: 14,
  trialVinLimit: 10,
  defaultVinLimit: 300,
  foundingShopPricing: true,
  skipTrialBonusVins: 50,
  trialReminderDays: [...DEFAULT_TRIAL_REMINDER_DAYS],
  trialReminderSubject: DEFAULT_TRIAL_REMINDER_SUBJECT,
  trialReminderHtml: DEFAULT_TRIAL_REMINDER_HTML,
  trialReminderText: DEFAULT_TRIAL_REMINDER_TEXT,
};

export async function getBillingSettings(): Promise<BillingSettings> {
  try {
    const db = await getDb();
    const settings = await db.collection("platform_settings").findOne({ type: "billing" });
    
    if (!settings) {
      return DEFAULT_BILLING_SETTINGS;
    }

    return {
      // Tier-specific pricing
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
      detectDogFounderProductId: settings.detectDogFounderProductId || "prod_UPkRVM5SeF3RiT",
      detectDogFounderPriceId: settings.detectDogFounderPriceId || "",
      detectDogFounderPrice: settings.detectDogFounderPrice ?? 229.95,
      detectDogFounderIncludedVins: settings.detectDogFounderIncludedVins ?? 300,
      // Legacy mosPro fields
      mosProProductId: settings.mosProProductId || "",
      mosProPriceId: settings.mosProPriceId || "",
      mosProPrice: settings.mosProPrice ?? 199,
      mosProIncludedVins: settings.mosProIncludedVins ?? 300,
      // VIN packs
      vinPack100ProductId: settings.vinPack100ProductId || "",
      vinPack100PriceId: settings.vinPack100PriceId || "",
      vinPack100Price: settings.vinPack100Price ?? 39,
      vinPack250ProductId: settings.vinPack250ProductId || "",
      vinPack250PriceId: settings.vinPack250PriceId || "",
      vinPack250Price: settings.vinPack250Price ?? 79,
      vinPack500ProductId: settings.vinPack500ProductId || "",
      vinPack500PriceId: settings.vinPack500PriceId || "",
      vinPack500Price: settings.vinPack500Price ?? 149,
      // Onboarding
      onboardingProductId: settings.onboardingProductId || "",
      onboardingPriceId: settings.onboardingPriceId || "",
      onboardingPrice: settings.onboardingPrice ?? 495,
      // Trial settings
      trialDays: settings.trialDays ?? 14,
      trialVinLimit: settings.trialVinLimit ?? 10,
      defaultVinLimit: settings.defaultVinLimit ?? 300,
      foundingShopPricing: settings.foundingShopPricing ?? true,
      skipTrialBonusVins: settings.skipTrialBonusVins ?? 50,
      trialReminderDays: sanitizeTrialReminderDays(settings.trialReminderDays),
      trialReminderSubject:
        typeof settings.trialReminderSubject === "string" && settings.trialReminderSubject.trim()
          ? settings.trialReminderSubject
          : DEFAULT_TRIAL_REMINDER_SUBJECT,
      trialReminderHtml:
        typeof settings.trialReminderHtml === "string" && settings.trialReminderHtml.trim()
          ? settings.trialReminderHtml
          : DEFAULT_TRIAL_REMINDER_HTML,
      trialReminderText:
        typeof settings.trialReminderText === "string" && settings.trialReminderText.trim()
          ? settings.trialReminderText
          : DEFAULT_TRIAL_REMINDER_TEXT,
    };
  } catch (error) {
    console.error("Error loading billing settings:", error);
    return DEFAULT_BILLING_SETTINGS;
  }
}

export async function saveBillingSettings(settings: Partial<BillingSettings>): Promise<void> {
  const db = await getDb();
  await db.collection("platform_settings").updateOne(
    { type: "billing" },
    { $set: { ...settings, type: "billing", updatedAt: new Date() } },
    { upsert: true }
  );
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

export async function fetchStripeProducts() {
  const stripeClient = getStripe();
  
  const [products, prices] = await Promise.all([
    stripeClient.products.list({ active: true, limit: 100 }),
    stripeClient.prices.list({ active: true, limit: 100, expand: ["data.product"] }),
  ]);

  return {
    products: products.data.map(p => ({
      id: p.id,
      name: p.name,
      description: p.description,
      metadata: p.metadata,
      active: p.active,
    })),
    prices: prices.data.map(p => ({
      id: p.id,
      productId: typeof p.product === "string" ? p.product : p.product.id,
      productName: typeof p.product === "object" && "name" in p.product ? p.product.name : null,
      unitAmount: p.unit_amount,
      currency: p.currency,
      type: p.type,
      recurring: p.recurring ? {
        interval: p.recurring.interval,
        intervalCount: p.recurring.interval_count,
      } : null,
      metadata: p.metadata,
    })),
  };
}

export const STRIPE_PRODUCTS = {
  professional: "prod_TgrceDug91whUy",
};
