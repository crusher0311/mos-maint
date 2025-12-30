// app/admin/billing/page.tsx
import { getDb } from "@/lib/mongo";
import BillingSettingsForm from "./BillingSettingsForm";

export const dynamic = "force-dynamic";

async function getBillingSettings() {
  const db = await getDb();
  const settings = await db.collection("platform_settings").findOne({ type: "billing" });
  
  return {
    professionalProductId: settings?.professionalProductId || "prod_TgrceDug91whUy",
    professionalPriceMonthly: settings?.professionalPriceMonthly || "",
    professionalPriceYearly: settings?.professionalPriceYearly || "",
    enterpriseProductId: settings?.enterpriseProductId || "",
    enterprisePriceMonthly: settings?.enterprisePriceMonthly || "",
    enterprisePriceYearly: settings?.enterprisePriceYearly || "",
    trialDays: settings?.trialDays || 14,
    defaultVinLimit: settings?.defaultVinLimit || 100,
  };
}

export default async function AdminBillingPage() {
  const settings = await getBillingSettings();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Billing Settings</h1>
        <p className="mt-1 text-sm text-gray-500">
          Configure Stripe product IDs, pricing, and billing defaults
        </p>
      </div>

      <BillingSettingsForm initialSettings={settings} />
    </div>
  );
}
