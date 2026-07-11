import { requireSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import IntervalsForm from "./IntervalsForm";
import IntervalsHeader from "./IntervalsHeader";
import ImportFromDocument from "./ImportFromDocument";
import { COMMON_SERVICES } from "@/lib/interval-common-services";
import { revalidatePath } from "next/cache";
import { Settings, Wrench, RotateCcw } from "lucide-react";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type ShopInterval = {
  key: string;
  name: string;
  category: string;
  useShop: boolean;
  excluded: boolean;
  miles: number | null;
  months: number | null;
  defaultMiles: number | null;
  defaultMonths: number | null;
};

async function getShopIntervals(shopId: number): Promise<{ intervals: ShopInterval[]; applyMode: "always" | "shop_only" }> {
  const db = await getDb();
  const shop = await db.collection("shops").findOne(
    { shopId },
    { projection: { "maintenance.intervals": 1, "maintenance.intervalApplyMode": 1 } }
  );
  
  const saved = shop?.maintenance?.intervals || {};
  const applyMode = shop?.maintenance?.intervalApplyMode || "always";
  
  const intervals = COMMON_SERVICES.map(svc => ({
    key: svc.key,
    name: svc.name,
    category: svc.category,
    useShop: saved[svc.key]?.useShop ?? false,
    excluded: saved[svc.key]?.excluded ?? false,
    miles: saved[svc.key]?.miles ?? null,
    months: saved[svc.key]?.months ?? null,
    defaultMiles: svc.defaultMiles,
    defaultMonths: svc.defaultMonths,
  }));

  return { intervals, applyMode };
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
  const [{ intervals, applyMode }, distanceUnit] = await Promise.all([
    getShopIntervals(shopId),
    getShopDistanceUnit(shopId)
  ]);

  async function saveIntervals(formData: FormData) {
    "use server";
    const unit = formData.get("distanceUnit") as string || "miles";
    const rawApplyMode = formData.get("intervalApplyMode") as string;
    const intervalApplyMode = rawApplyMode === "always" ? "always" : "shop_only";
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
          "maintenance.intervalApplyMode": intervalApplyMode,
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );

    await Promise.all([
      db.collection("cached_plans").deleteMany({ shopId }),
      db.collection("maintenance_analysis_cache").deleteMany({ shopId }),
    ]);

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

      <ImportFromDocument
        intervals={intervals}
        distanceUnit={distanceUnit}
        applyMode={applyMode}
        saveAction={saveIntervals}
      />

      <IntervalsForm 
        intervals={intervals} 
        distanceUnit={distanceUnit}
        applyMode={applyMode}
        saveAction={saveIntervals}
      />
    </main>
  );
}
