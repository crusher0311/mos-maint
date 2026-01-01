import { requireSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import MaintenanceForm from "./MaintenanceForm";
import MaintenanceHeader from "./MaintenanceHeader";
import { revalidatePath } from "next/cache";
import { Settings, Clock, Car } from "lucide-react";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_SOON_MILES = 1000;
const DEFAULT_SOON_DAYS = 30;

async function getMaintenanceSettings(shopId: number) {
  const db = await getDb();
  const shop = await db.collection("shops").findOne(
    { shopId },
    { projection: { maintenance: 1, distanceUnit: 1 } }
  );
  return {
    dueSoonMiles: shop?.maintenance?.dueSoonMiles ?? DEFAULT_SOON_MILES,
    dueSoonDays: shop?.maintenance?.dueSoonDays ?? DEFAULT_SOON_DAYS,
    distanceUnit: (shop?.distanceUnit as "miles" | "kilometers") || "miles",
  };
}

export default async function MaintenanceSettingsPage() {
  const sess = await requireSession();
  const shopId = Number(sess.shopId);
  const current = await getMaintenanceSettings(shopId);

  async function save(formData: FormData) {
    "use server";
    const dueSoonMiles = Math.max(0, parseInt(String(formData.get("dueSoonMiles") || "1000"), 10) || DEFAULT_SOON_MILES);
    const dueSoonDays = Math.max(0, parseInt(String(formData.get("dueSoonDays") || "30"), 10) || DEFAULT_SOON_DAYS);

    const db = await getDb();
    await db.collection("shops").updateOne(
      { shopId },
      {
        $set: {
          "maintenance.dueSoonMiles": dueSoonMiles,
          "maintenance.dueSoonDays": dueSoonDays,
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );

    revalidatePath("/dashboard/vehicles/[vin]/plan");
    revalidatePath("/dashboard/settings/maintenance");
  }

  return (
    <main className="p-6 space-y-6 max-w-2xl">
      <MaintenanceHeader />

      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
        <div className="flex items-start gap-3">
          <Settings className="w-5 h-5 text-blue-600 mt-0.5" />
          <div>
            <p className="font-medium text-blue-800">Customize "Due Soon" alerts</p>
            <p className="text-sm text-blue-700 mt-1">
              These settings control when maintenance items appear in the "Due Soon" category on vehicle maintenance plans.
              Items within these thresholds will be highlighted for proactive service recommendations.
            </p>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="font-semibold text-gray-900">Current Settings</h2>
        </div>
        <div className="px-6 py-4 grid grid-cols-2 gap-4">
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <Car className="w-4 h-4 text-gray-500" />
              <span className="text-sm font-medium text-gray-700">Mileage Threshold</span>
            </div>
            <p className="text-2xl font-bold text-gray-900">
              {current.distanceUnit === "kilometers" 
                ? Math.round(current.dueSoonMiles * 1.60934).toLocaleString()
                : current.dueSoonMiles.toLocaleString()}
            </p>
            <p className="text-xs text-gray-500 mt-1">
              {current.distanceUnit === "kilometers" ? "km" : "miles"} before due
            </p>
          </div>
          <div className="bg-gray-50 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-2">
              <Clock className="w-4 h-4 text-gray-500" />
              <span className="text-sm font-medium text-gray-700">Time Threshold</span>
            </div>
            <p className="text-2xl font-bold text-gray-900">{current.dueSoonDays}</p>
            <p className="text-xs text-gray-500 mt-1">days before due</p>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="font-semibold text-gray-900">Update Thresholds</h2>
          <p className="text-sm text-gray-500 mt-1">
            Set when maintenance items should appear as "Due Soon" for your shop.
          </p>
        </div>
        <div className="px-6 py-4">
          <MaintenanceForm initial={current} action={save} distanceUnit={current.distanceUnit} />
        </div>
      </div>

      <div className="bg-gray-50 border border-gray-200 rounded-xl p-4">
        <h3 className="font-medium text-gray-800 mb-2">How it works</h3>
        <ul className="text-sm text-gray-600 space-y-2">
          <li className="flex items-start gap-2">
            <span className="inline-block w-2 h-2 bg-red-500 rounded-full mt-1.5"></span>
            <span><strong>Overdue</strong> — Past due by mileage or date, or DVI red items</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="inline-block w-2 h-2 bg-amber-500 rounded-full mt-1.5"></span>
            <span><strong>Due Soon</strong> — Within your configured thresholds, or DVI yellow items</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="inline-block w-2 h-2 bg-emerald-500 rounded-full mt-1.5"></span>
            <span><strong>Upcoming</strong> — Not yet within thresholds</span>
          </li>
        </ul>
      </div>
    </main>
  );
}
