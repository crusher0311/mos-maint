import { getBillingSettings } from "@/lib/stripe";
import BillingSettingsForm from "./BillingSettingsForm";

export const dynamic = "force-dynamic";

export default async function AdminBillingPage() {
  const settings = await getBillingSettings();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Stripe Billing Configuration</h1>
        <p className="mt-1 text-sm text-gray-500">
          Configure Stripe products and pricing for MOS Pro subscriptions and VIN packs
        </p>
      </div>

      <BillingSettingsForm initialSettings={settings} />
    </div>
  );
}
