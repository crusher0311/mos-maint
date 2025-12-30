import Stripe from "stripe";
import { getDb } from "@/lib/mongo";

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

export const STRIPE_PRODUCTS = {
  professional: "prod_TgrceDug91whUy",
};

export type BillingSettings = {
  professionalProductId: string;
  professionalPriceMonthly: string;
  professionalPriceYearly: string;
  enterpriseProductId: string;
  enterprisePriceMonthly: string;
  enterprisePriceYearly: string;
  trialDays: number;
  defaultVinLimit: number;
};

const DEFAULT_BILLING_SETTINGS: BillingSettings = {
  professionalProductId: "prod_TgrceDug91whUy",
  professionalPriceMonthly: "",
  professionalPriceYearly: "",
  enterpriseProductId: "",
  enterprisePriceMonthly: "",
  enterprisePriceYearly: "",
  trialDays: 14,
  defaultVinLimit: 100,
};

export async function getBillingSettings(): Promise<BillingSettings> {
  try {
    const db = await getDb();
    const settings = await db.collection("platform_settings").findOne({ type: "billing" });
    
    if (!settings) {
      return DEFAULT_BILLING_SETTINGS;
    }

    return {
      professionalProductId: settings.professionalProductId || DEFAULT_BILLING_SETTINGS.professionalProductId,
      professionalPriceMonthly: settings.professionalPriceMonthly || "",
      professionalPriceYearly: settings.professionalPriceYearly || "",
      enterpriseProductId: settings.enterpriseProductId || "",
      enterprisePriceMonthly: settings.enterprisePriceMonthly || "",
      enterprisePriceYearly: settings.enterprisePriceYearly || "",
      trialDays: settings.trialDays ?? DEFAULT_BILLING_SETTINGS.trialDays,
      defaultVinLimit: settings.defaultVinLimit ?? DEFAULT_BILLING_SETTINGS.defaultVinLimit,
    };
  } catch (error) {
    console.error("Error loading billing settings:", error);
    return DEFAULT_BILLING_SETTINGS;
  }
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
