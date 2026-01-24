import { requireSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import IntervalsForm from "./IntervalsForm";
import IntervalsHeader from "./IntervalsHeader";
import { revalidatePath } from "next/cache";
import { Settings, Wrench, RotateCcw } from "lucide-react";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Categories aligned with CARFAX service categories
const COMMON_SERVICES = [
  { key: "oil", name: "Oil Change / Engine Oil Filter", defaultMiles: 5000, defaultMonths: 6 },
  { key: "tire_rotation", name: "Tire Rotation", defaultMiles: 7500, defaultMonths: 6 },
  { key: "cabin_air", name: "Cabin Air Filter Replacement", defaultMiles: 25000, defaultMonths: 24 },
  { key: "engine_air", name: "Air Filter Replacement", defaultMiles: 30000, defaultMonths: 36 },
  { key: "coolant", name: "Radiator Antifreeze Flush", defaultMiles: 60000, defaultMonths: 60 },
  { key: "trans_auto", name: "Automatic Transmission Fluid", defaultMiles: 60000, defaultMonths: 60 },
  { key: "trans_manual", name: "Manual Transmission Fluid", defaultMiles: 60000, defaultMonths: 60 },
  { key: "transfer_case", name: "Transfer Case Fluid", defaultMiles: 60000, defaultMonths: 60 },
  { key: "differential", name: "Differential Fluid", defaultMiles: 60000, defaultMonths: 60 },
  { key: "serpentine_belt", name: "Serpentine Belt Replacement", defaultMiles: 60000, defaultMonths: 60 },
  { key: "fuel_system", name: "Fuel System Cleaning", defaultMiles: 30000, defaultMonths: 36 },
  { key: "fuel_filter", name: "Fuel Filter Replacement", defaultMiles: 30000, defaultMonths: 36 },
  { key: "brake_pads", name: "Brake Linings/Pads Replacement", defaultMiles: 40000, defaultMonths: 48 },
  { key: "emissions", name: "Emissions Test", defaultMiles: null, defaultMonths: 24 },
  { key: "power_steering", name: "Power Steering Fluid", defaultMiles: 60000, defaultMonths: 60 },
  { key: "battery", name: "Battery Replacement", defaultMiles: null, defaultMonths: 48 },
  { key: "ac_refrigerant", name: "A/C Refrigerant Refill", defaultMiles: null, defaultMonths: 36 },
  { key: "wheel_alignment", name: "Wheel Alignment", defaultMiles: 15000, defaultMonths: 12 },
];

export type ShopInterval = {
  key: string;
  name: string;
  useShop: boolean;
  excluded: boolean;
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
    excluded: saved[svc.key]?.excluded ?? false,
    miles: saved[svc.key]?.miles ?? null,
    months: saved[svc.key]?.months ?? null,
    defaultMiles: svc.defaultMiles,
    defaultMonths: svc.defaultMonths,
  }));
}

async function getShopDistanceUnit(shopId: number): Promise<"miles" | "kilometers"> {
  const db = await getDb();
  const shop = await db.collection("shops").findOne(
    { shopId },
    { projection: { "preferences.distanceUnit": 1 } }
  );
  return shop?.preferences?.distanceUnit || "miles";
}

export default async function IntervalsPage() {
  const sess = await requireSession();
  const shopId = Number(sess.shopId);
  const [intervals, distanceUnit] = await Promise.all([
    getShopIntervals(shopId),
    getShopDistanceUnit(shopId)
  ]);

  async function saveIntervals(formData: FormData) {
    "use server";
    const unit = formData.get("distanceUnit") as string || "miles";
    const updates: Record<string, { useShop: boolean; excluded: boolean; miles: number | null; months: number | null }> = {};
    
    for (const svc of COMMON_SERVICES) {
      const useShop = formData.get(`${svc.key}_useShop`) === "on";
      const excluded = formData.get(`${svc.key}_excluded`) === "on";
      const distanceRaw = formData.get(`${svc.key}_distance`);
      const monthsRaw = formData.get(`${svc.key}_months`);
      
      let distance = distanceRaw ? parseInt(String(distanceRaw), 10) : null;
      const months = monthsRaw ? parseInt(String(monthsRaw), 10) : null;
      
      // Convert km to miles for storage (always store in miles internally)
      let miles: number | null = null;
      if (distance && distance > 0) {
        miles = unit === "kilometers" ? Math.round(distance * 0.621371) : distance;
      }
      
      updates[svc.key] = {
        useShop,
        excluded,
        miles,
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

  return (
    <main className="p-6 space-y-6 max-w-4xl">
      <IntervalsHeader />

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
        distanceUnit={distanceUnit}
        saveAction={saveIntervals}
      />
    </main>
  );
}
