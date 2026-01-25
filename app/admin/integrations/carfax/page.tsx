// app/admin/integrations/carfax/page.tsx
import { getDb } from "@/lib/mongo";
import { revalidatePath } from "next/cache";
import { CheckCircle, XCircle, AlertCircle, Building2 } from "lucide-react";
import CarfaxAdminForm from "./CarfaxAdminForm";

export const dynamic = "force-dynamic";

function checkEnvConfig() {
  const hasUrl = Boolean(process.env.CARFAX_POST_URL);
  const hasPdi = Boolean(process.env.CARFAX_PDI);
  return { hasUrl, hasPdi, configured: hasUrl && hasPdi };
}

async function getShopsWithCarfax() {
  const db = await getDb();
  const shops = await db.collection("shops").find({}).toArray();
  
  return shops.map((shop) => ({
    _id: String(shop._id),
    shopId: shop.shopId,
    name: shop.name || `Shop ${shop.shopId}`,
    locationId: shop.carfax?.locationId || shop.carfaxLocationId || "",
  }));
}

export default async function CarfaxAdminPage() {
  const envConfig = checkEnvConfig();
  const shops = await getShopsWithCarfax();
  const configuredCount = shops.filter((s) => s.locationId).length;

  async function saveLocationId(formData: FormData) {
    "use server";
    const shopId = Number(formData.get("shopId"));
    const locationId = String(formData.get("locationId") || "").trim();
    
    const db = await getDb();
    await db.collection("shops").updateOne(
      { shopId },
      {
        $set: {
          carfax: { locationId },
          carfaxLocationId: locationId,
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );

    revalidatePath("/admin/integrations/carfax");
    revalidatePath("/dashboard/vehicles/[vin]");
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">CARFAX Integration</h1>
        <p className="mt-1 text-sm text-gray-500">
          Manage CARFAX Location IDs for all shops
        </p>
      </div>

      <div className={`rounded-xl border p-4 ${envConfig.configured ? 'bg-green-50 border-green-200' : 'bg-amber-50 border-amber-200'}`}>
        <div className="flex items-center gap-3">
          {envConfig.configured ? (
            <CheckCircle className="w-5 h-5 text-green-600" />
          ) : (
            <AlertCircle className="w-5 h-5 text-amber-600" />
          )}
          <div>
            <p className={`font-medium ${envConfig.configured ? 'text-green-800' : 'text-amber-800'}`}>
              {envConfig.configured ? 'CARFAX API Configured' : 'CARFAX API Not Configured'}
            </p>
            <p className={`text-sm ${envConfig.configured ? 'text-green-700' : 'text-amber-700'}`}>
              {envConfig.configured 
                ? `${configuredCount} of ${shops.length} shops have Location IDs configured` 
                : 'Set CARFAX_POST_URL and CARFAX_PDI environment variables first'}
            </p>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="font-semibold text-gray-900">Environment Status</h2>
        </div>
        <div className="px-6 py-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex items-center justify-between py-2 px-4 bg-gray-50 rounded-lg">
            <div className="flex items-center gap-3">
              {envConfig.hasUrl ? (
                <CheckCircle className="w-4 h-4 text-green-600" />
              ) : (
                <XCircle className="w-4 h-4 text-red-500" />
              )}
              <span className="text-sm text-gray-700">CARFAX_POST_URL</span>
            </div>
            <span className={`text-xs px-2 py-1 rounded-full ${envConfig.hasUrl ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
              {envConfig.hasUrl ? 'Set' : 'Missing'}
            </span>
          </div>
          <div className="flex items-center justify-between py-2 px-4 bg-gray-50 rounded-lg">
            <div className="flex items-center gap-3">
              {envConfig.hasPdi ? (
                <CheckCircle className="w-4 h-4 text-green-600" />
              ) : (
                <XCircle className="w-4 h-4 text-red-500" />
              )}
              <span className="text-sm text-gray-700">CARFAX_PDI</span>
            </div>
            <span className={`text-xs px-2 py-1 rounded-full ${envConfig.hasPdi ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
              {envConfig.hasPdi ? 'Set' : 'Missing'}
            </span>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-gray-900">Shop Location IDs</h2>
            <p className="text-sm text-gray-500 mt-1">
              Enter the CARFAX Location ID for each shop. This is provided by CARFAX.
            </p>
          </div>
          <div className="flex items-center gap-2 text-sm text-gray-600">
            <Building2 className="w-4 h-4" />
            {configuredCount}/{shops.length} configured
          </div>
        </div>
        
        <div className="divide-y divide-gray-100">
          {shops.length === 0 ? (
            <div className="px-6 py-8 text-center text-gray-500">
              No shops found. Create shops first before configuring CARFAX.
            </div>
          ) : (
            shops.map((shop) => (
              <div key={shop._id} className="px-6 py-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="flex-shrink-0 w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center">
                      <span className="text-sm font-medium text-mos-blue">
                        {shop.name.charAt(0).toUpperCase()}
                      </span>
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900 truncate">{shop.name}</p>
                      <p className="text-xs text-gray-500">Shop ID: {shop.shopId}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {shop.locationId ? (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs bg-green-100 text-green-700">
                        <CheckCircle className="w-3 h-3" />
                        Configured
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs bg-gray-100 text-gray-600">
                        <XCircle className="w-3 h-3" />
                        Not Set
                      </span>
                    )}
                    <CarfaxAdminForm 
                      shopId={shop.shopId} 
                      currentLocationId={shop.locationId}
                      action={saveLocationId}
                    />
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
