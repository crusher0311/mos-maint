import { requireSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import IntervalsForm from "./IntervalsForm";
import IntervalsHeader from "./IntervalsHeader";
import ImportFromDocument from "./ImportFromDocument";
import ChemicalProvidersForm from "./ChemicalProvidersForm";
import { COMMON_SERVICES } from "@/lib/interval-common-services";
import {
  parseChemicalProviders,
  type ChemicalProvider,
} from "@/lib/plan-build/chemical-providers";
import { revalidatePath } from "next/cache";
import { Settings, Wrench, RotateCcw, FlaskConical } from "lucide-react";

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

async function getShopIntervals(shopId: number): Promise<{ intervals: ShopInterval[]; applyMode: "always" | "shop_only"; chemicalProviders: ChemicalProvider[] }> {
  const db = await getDb();
  const shop = await db.collection("shops").findOne(
    { shopId },
    { projection: { "maintenance.intervals": 1, "maintenance.intervalApplyMode": 1, "maintenance.chemicalProviders": 1 } }
  );
  
  const saved = shop?.maintenance?.intervals || {};
  const applyMode = shop?.maintenance?.intervalApplyMode || "always";
  const chemicalProviders = parseChemicalProviders(shop?.maintenance?.chemicalProviders);
  
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

  return { intervals, applyMode, chemicalProviders };
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
  const [{ intervals, applyMode, chemicalProviders }, distanceUnit] = await Promise.all([
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

  // Task #803: chemical-provider schedules (e.g. BG). The client form
  // submits the full provider list as one JSON field (values in the shop's
  // display unit); we sanitize + convert km→miles here and clear the plan
  // caches exactly like saveIntervals so provider tabs rebuild fresh.
  async function saveChemicalProviders(formData: FormData) {
    "use server";
    const unit = (formData.get("distanceUnit") as string) || "miles";
    let parsed: unknown = [];
    try {
      parsed = JSON.parse(String(formData.get("providersJson") || "[]"));
    } catch {
      parsed = [];
    }
    if (!Array.isArray(parsed)) parsed = [];

    // Convert display-unit distances to internal miles BEFORE sanitizing.
    const inMiles = (parsed as any[]).map((p) => {
      const intervals: Record<string, { miles: number | null; months: number | null }> = {};
      if (p && typeof p === "object" && p.intervals && typeof p.intervals === "object") {
        for (const [key, val] of Object.entries(p.intervals as Record<string, any>)) {
          const distance = val?.distance != null && Number(val.distance) > 0 ? Number(val.distance) : null;
          const months = val?.months != null && Number(val.months) > 0 ? Number(val.months) : null;
          intervals[key] = {
            miles: distance != null
              ? (unit === "kilometers" ? Math.round(distance * 0.621371) : Math.round(distance))
              : null,
            months,
          };
        }
      }
      return { id: p?.id, name: p?.name, enabled: p?.enabled === true, templateId: p?.templateId ?? null, intervals };
    });

    const providers = parseChemicalProviders(inMiles);

    const db = await getDb();
    await db.collection("shops").updateOne(
      { shopId },
      {
        $set: {
          "maintenance.chemicalProviders": providers,
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

      <div className="bg-purple-50 border border-purple-200 rounded-xl p-4">
        <div className="flex items-start gap-3">
          <FlaskConical className="w-5 h-5 text-purple-600 mt-0.5" />
          <div>
            <p className="font-medium text-purple-800">Chemical Provider Plans</p>
            <p className="text-sm text-purple-700 mt-1">
              Add maintenance schedules from chemical providers (like BG). Enabled providers
              appear as extra plan tabs on each vehicle's maintenance plan, alongside the
              OE and Shop plans.
            </p>
          </div>
        </div>
      </div>

      <ChemicalProvidersForm
        providers={chemicalProviders}
        distanceUnit={distanceUnit}
        saveAction={saveChemicalProviders}
      />
    </main>
  );
}
