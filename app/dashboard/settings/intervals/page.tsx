import { requireSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import IntervalsForm from "./IntervalsForm";
import { revalidatePath } from "next/cache";
import { Settings, Wrench, RotateCcw } from "lucide-react";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COMMON_SERVICES = [
  { key: "oil", name: "Oil & Filter Change", defaultMiles: 5000, defaultMonths: 6 },
  { key: "tire_rotation", name: "Tire Rotation", defaultMiles: 7500, defaultMonths: 6 },
  { key: "engine_air", name: "Engine Air Filter", defaultMiles: 30000, defaultMonths: 36 },
  { key: "cabin_air", name: "Cabin Air Filter", defaultMiles: 25000, defaultMonths: 24 },
  { key: "inspect_brakes", name: "Brake Inspection", defaultMiles: 15000, defaultMonths: 12 },
  { key: "brake_fluid", name: "Brake Fluid Flush", defaultMiles: 30000, defaultMonths: 36 },
  { key: "coolant", name: "Coolant Flush", defaultMiles: 60000, defaultMonths: 60 },
  { key: "trans_fluid", name: "Transmission Fluid", defaultMiles: 60000, defaultMonths: 60 },
  { key: "spark_plugs", name: "Spark Plugs", defaultMiles: 60000, defaultMonths: 60 },
  { key: "battery", name: "Battery Inspection/Replace", defaultMiles: null, defaultMonths: 48 },
  { key: "alignment", name: "Wheel Alignment", defaultMiles: 25000, defaultMonths: 24 },
  { key: "multi_point", name: "Multi-Point Inspection", defaultMiles: 15000, defaultMonths: 12 },
  { key: "steering", name: "Steering Components", defaultMiles: 60000, defaultMonths: 60 },
  { key: "suspension", name: "Suspension", defaultMiles: 60000, defaultMonths: 60 },
];

export type ShopInterval = {
  key: string;
  name: string;
  useShop: boolean;
  miles: number | null;
  months: number | null;
  defaultMiles: number | null;
  defaultMonths: number | null;
};

async function getShopIntervals(shopId: number): Promise<ShopInterval[]> {
  const db = await getDb();
  const shop = await db.collection("shops").findOne(
    { shopId },
    { projection: { "maintenance.intervals": 1 } }
  );
  
  const saved = shop?.maintenance?.intervals || {};
  
  return COMMON_SERVICES.map(svc => ({
    key: svc.key,
    name: svc.name,
    useShop: saved[svc.key]?.useShop ?? false,
    miles: saved[svc.key]?.miles ?? null,
    months: saved[svc.key]?.months ?? null,
    defaultMiles: svc.defaultMiles,
    defaultMonths: svc.defaultMonths,
  }));
}

export default async function IntervalsPage() {
  const sess = await requireSession();
  const shopId = Number(sess.shopId);
  const intervals = await getShopIntervals(shopId);

  async function saveIntervals(formData: FormData) {
    "use server";
    const updates: Record<string, { useShop: boolean; miles: number | null; months: number | null }> = {};
    
    for (const svc of COMMON_SERVICES) {
      const useShop = formData.get(`${svc.key}_useShop`) === "on";
      const milesRaw = formData.get(`${svc.key}_miles`);
      const monthsRaw = formData.get(`${svc.key}_months`);
      
      const miles = milesRaw ? parseInt(String(milesRaw), 10) : null;
      const months = monthsRaw ? parseInt(String(monthsRaw), 10) : null;
      
      updates[svc.key] = {
        useShop,
        miles: miles && miles > 0 ? miles : null,
        months: months && months > 0 ? months : null,
      };
    }

    const db = await getDb();
    await db.collection("shops").updateOne(
      { shopId },
      {
        $set: {
          "maintenance.intervals": updates,
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );

    revalidatePath("/dashboard/settings/intervals");
    revalidatePath("/dashboard/vehicles/[vin]/plan");
  }

  async function resetToDefaults() {
    "use server";
    const db = await getDb();
    await db.collection("shops").updateOne(
      { shopId },
      {
        $unset: { "maintenance.intervals": "" },
        $set: { updatedAt: new Date() },
      }
    );
    revalidatePath("/dashboard/settings/intervals");
    revalidatePath("/dashboard/vehicles/[vin]/plan");
  }

  return (
    <main className="p-6 space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">Shop Maintenance Intervals</h1>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
        <div className="flex items-start gap-3">
          <Settings className="w-5 h-5 text-blue-600 mt-0.5" />
          <div>
            <p className="font-medium text-blue-800">Override OEM Schedules</p>
            <p className="text-sm text-blue-700 mt-1">
              Set custom maintenance intervals for your shop. When enabled, these will override 
              the manufacturer's recommended schedules on vehicle maintenance plans.
            </p>
          </div>
        </div>
      </div>

      <IntervalsForm 
        intervals={intervals} 
        saveAction={saveIntervals}
        resetAction={resetToDefaults}
      />
    </main>
  );
}
