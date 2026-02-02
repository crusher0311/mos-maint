// app/dashboard/settings/carfax/page.tsx
import { requireSession } from "@/lib/auth";
import sql from "@/lib/db/postgres";
import CarfaxForm from "./CarfaxForm";
import { revalidatePath } from "next/cache";
import { CheckCircle, AlertCircle, XCircle } from "lucide-react";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getCurrent(shopId: number) {
  const shops = await sql`
    SELECT carfax_location_id FROM shops WHERE shop_id = ${String(shopId)}
  `;
  const shop = shops[0] as any;
  return {
    locationId: shop?.carfax_location_id || "",
  };
}

function checkEnvConfig() {
  const hasUrl = Boolean(process.env.CARFAX_POST_URL);
  const hasPdi = Boolean(process.env.CARFAX_PDI);
  return { hasUrl, hasPdi, configured: hasUrl && hasPdi };
}

export default async function CarfaxSettingsPage() {
  const sess = await requireSession();
  const shopId = Number(sess.shopId);
  const current = await getCurrent(shopId);
  const envConfig = checkEnvConfig();
  const isFullyConfigured = envConfig.configured && Boolean(current.locationId);

  // Server Action to save the locationId
  async function save(formData: FormData) {
    "use server";
    const loc = String(formData.get("locationId") || "").trim();

    await sql`
      UPDATE shops SET
        carfax_location_id = ${loc},
        updated_at = NOW()
      WHERE shop_id = ${String(shopId)}
    `;

    revalidatePath("/dashboard/vehicles/[vin]");
    revalidatePath("/dashboard/settings/carfax");
  }

  return (
    <main className="p-6 space-y-6 max-w-2xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">CARFAX Integration</h1>
      </div>

      <div className={`rounded-xl border p-4 ${isFullyConfigured ? 'bg-green-50 border-green-200' : 'bg-amber-50 border-amber-200'}`}>
        <div className="flex items-center gap-3">
          {isFullyConfigured ? (
            <CheckCircle className="w-5 h-5 text-green-600" />
          ) : (
            <AlertCircle className="w-5 h-5 text-amber-600" />
          )}
          <div>
            <p className={`font-medium ${isFullyConfigured ? 'text-green-800' : 'text-amber-800'}`}>
              {isFullyConfigured ? 'CARFAX is connected' : 'CARFAX setup incomplete'}
            </p>
            <p className={`text-sm ${isFullyConfigured ? 'text-green-700' : 'text-amber-700'}`}>
              {isFullyConfigured 
                ? 'Service history will appear on vehicle pages.' 
                : 'Complete the setup below to enable CARFAX service history.'}
            </p>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="font-semibold text-gray-900">Configuration Status</h2>
        </div>
        <div className="px-6 py-4 space-y-3">
          <div className="flex items-center justify-between py-2">
            <div className="flex items-center gap-3">
              {envConfig.hasUrl ? (
                <CheckCircle className="w-4 h-4 text-green-600" />
              ) : (
                <XCircle className="w-4 h-4 text-red-500" />
              )}
              <span className="text-sm text-gray-700">API URL</span>
            </div>
            <span className={`text-xs px-2 py-1 rounded-full ${envConfig.hasUrl ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
              {envConfig.hasUrl ? 'Configured' : 'Missing'}
            </span>
          </div>
          <div className="flex items-center justify-between py-2">
            <div className="flex items-center gap-3">
              {envConfig.hasPdi ? (
                <CheckCircle className="w-4 h-4 text-green-600" />
              ) : (
                <XCircle className="w-4 h-4 text-red-500" />
              )}
              <span className="text-sm text-gray-700">Product Data ID</span>
            </div>
            <span className={`text-xs px-2 py-1 rounded-full ${envConfig.hasPdi ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
              {envConfig.hasPdi ? 'Configured' : 'Missing'}
            </span>
          </div>
          <div className="flex items-center justify-between py-2">
            <div className="flex items-center gap-3">
              {current.locationId ? (
                <CheckCircle className="w-4 h-4 text-green-600" />
              ) : (
                <XCircle className="w-4 h-4 text-red-500" />
              )}
              <span className="text-sm text-gray-700">Shop Location ID</span>
            </div>
            <span className={`text-xs px-2 py-1 rounded-full ${current.locationId ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
              {current.locationId ? 'Configured' : 'Not Set'}
            </span>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="font-semibold text-gray-900">Shop Location ID</h2>
          <p className="text-sm text-gray-500 mt-1">
            Enter your shop's unique CARFAX Location ID. This is provided by CARFAX when you set up your account.
          </p>
        </div>
        <div className="px-6 py-4">
          {envConfig.configured ? (
            <CarfaxForm shopId={shopId} initial={current} action={save} />
          ) : (
            <div className="text-sm text-amber-700 bg-amber-50 p-4 rounded-lg">
              <p className="font-medium mb-1">Environment not configured</p>
              <p>The CARFAX API URL and Product Data ID must be set up before you can configure your Location ID. Please contact your administrator.</p>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
