import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDb } from "@/lib/mongo";
import { toKeyFromFreeText } from "@/lib/service-keys";

export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.isPlatformAdmin) {
      return NextResponse.json({ error: "Platform admin access required" }, { status: 403 });
    }

    const vin = req.nextUrl.searchParams.get("vin")?.toUpperCase();
    const shopIdParam = req.nextUrl.searchParams.get("shopId");

    if (!vin || vin.length !== 17) {
      return NextResponse.json({ error: "Valid 17-character VIN required" }, { status: 400 });
    }
    if (!shopIdParam) {
      return NextResponse.json({ error: "shopId required" }, { status: 400 });
    }

    const shopId = Number(shopIdParam);
    const db = await getDb();

    const shopDoc = await db.collection("shops").findOne(
      { shopId },
      { projection: { name: 1, "maintenance.intervals": 1, "maintenance.intervalApplyMode": 1 } }
    );

    if (!shopDoc) {
      return NextResponse.json({ error: `Shop ${shopId} not found` }, { status: 404 });
    }

    const intervalApplyMode = shopDoc?.maintenance?.intervalApplyMode || "always";
    const shopIntervals: Record<string, any> = shopDoc?.maintenance?.intervals ?? {};

    const [protractorWOs, tekmetricWOs] = await Promise.all([
      db.collection("protractor_work_orders").find({
        shopId,
        $or: [
          { vin: vin.toUpperCase() },
          { "data.VIN": vin.toUpperCase() },
          { "ServiceItem.VIN": vin.toUpperCase() }
        ]
      }).sort({ "Header.LastModifiedTime": -1 }).limit(20).toArray(),
      db.collection("tekmetric_work_orders").find({
        shopId: { $in: [String(shopId), Number(shopId)] },
        vin: vin.toUpperCase()
      }).sort({ completedDate: -1 }).limit(50).toArray(),
    ]);

    const rawHistory: Array<{
      source: string;
      serviceName: string;
      mileage: number | null;
      date: string | null;
      matchedKeys: string[];
      roNumber?: string;
    }> = [];

    for (const wo of protractorWOs) {
      const wMileage = wo.Odometer ?? wo.OutUsage ?? wo.data?.Odometer ?? null;
      const dateStr = wo.Header?.LastModifiedTime ?? wo.Header?.CreationTime ?? wo.data?.Header?.LastModifiedTime ?? null;
      const roNum = wo.workOrderNumber || wo.WorkOrderNumber || wo.data?.WorkOrderNumber || null;
      const servicePackages = wo.ServicePackages ?? wo.data?.ServicePackages ?? [];
      for (const pkg of servicePackages) {
        const serviceName = pkg.Title ?? pkg.Description ?? "";
        if (serviceName) {
          rawHistory.push({
            source: "protractor",
            serviceName,
            mileage: wMileage,
            date: dateStr,
            matchedKeys: toKeyFromFreeText(serviceName),
            roNumber: roNum,
          });
        }
        for (const line of pkg.ServicePackageLines ?? []) {
          const lineName = line.Description ?? "";
          if (lineName && lineName !== serviceName) {
            rawHistory.push({
              source: "protractor_line",
              serviceName: lineName,
              mileage: wMileage,
              date: dateStr,
              matchedKeys: toKeyFromFreeText(lineName),
              roNumber: roNum,
            });
          }
        }
      }
    }

    for (const wo of tekmetricWOs) {
      const isCompleted = !!wo.completedDate;
      const wMileage = wo.odometer ?? wo.data?.milesOut ?? wo.data?.milesIn ?? null;
      const date = wo.completedDate || null;
      const roNum = wo.repairOrderNumber || wo.data?.repairOrderNumber || null;
      const jobs = wo.data?.jobs ?? wo.jobs ?? [];
      for (const job of jobs) {
        if (!isCompleted && !job.authorized) continue;
        const serviceName = job.name ?? job.description ?? "";
        if (serviceName) {
          rawHistory.push({
            source: "tekmetric",
            serviceName,
            mileage: wMileage,
            date,
            matchedKeys: toKeyFromFreeText(serviceName),
            roNumber: roNum,
          });
        }
      }
    }

    const unmatchedJobs = rawHistory.filter(h => h.matchedKeys.length === 0);

    const lastDoneByKey: Record<string, {
      serviceName: string;
      mileage: number | null;
      date: string | null;
      source: string;
    }> = {};

    for (const h of rawHistory) {
      for (const k of h.matchedKeys) {
        const prev = lastDoneByKey[k];
        const candTime = h.date ? new Date(h.date).getTime() : -Infinity;
        const prevTime = prev?.date ? new Date(prev.date).getTime() : -Infinity;
        if (!prev || candTime > prevTime) {
          lastDoneByKey[k] = {
            serviceName: h.serviceName,
            mileage: h.mileage,
            date: h.date,
            source: h.source,
          };
        }
      }
    }

    const activeShopOverrides: Record<string, {
      miles: number | null;
      months: number | null;
      excluded: boolean;
      useShop: boolean;
    }> = {};
    for (const [key, val] of Object.entries(shopIntervals)) {
      const v = val as any;
      if (v.useShop || v.excluded) {
        activeShopOverrides[key] = {
          miles: v.miles ?? null,
          months: v.months ?? null,
          excluded: !!v.excluded,
          useShop: !!v.useShop,
        };
      }
    }

    const cachedPlan = await db.collection("cached_plans").findOne(
      { vin: vin.toUpperCase(), shopId: { $in: [String(shopId), Number(shopId)] } },
      { sort: { createdAt: -1 } }
    );

    return NextResponse.json({
      ok: true,
      vin,
      shopId,
      shopName: shopDoc.name || null,
      intervalApplyMode,
      summary: {
        protractorWorkOrders: protractorWOs.length,
        tekmetricWorkOrders: tekmetricWOs.length,
        totalServiceJobs: rawHistory.length,
        unmatchedJobs: unmatchedJobs.length,
        serviceKeysFound: Object.keys(lastDoneByKey).length,
      },
      lastDoneByServiceKey: lastDoneByKey,
      unmatchedJobs: unmatchedJobs.map(j => ({
        serviceName: j.serviceName,
        source: j.source,
        date: j.date,
        mileage: j.mileage,
      })),
      activeShopIntervalOverrides: activeShopOverrides,
      cachedPlan: cachedPlan ? {
        createdAt: cachedPlan.createdAt,
        expiresAt: cachedPlan.expiresAt,
        mileage: cachedPlan.mileage,
        overdueCount: cachedPlan.plan?.buckets?.overdue?.length ?? 0,
        dueSoonCount: cachedPlan.plan?.buckets?.dueSoon?.length ?? 0,
        upcomingCount: cachedPlan.plan?.buckets?.upcoming?.length ?? 0,
        overdueItems: (cachedPlan.plan?.buckets?.overdue ?? []).map((i: any) => ({
          title: i.title,
          serviceKey: i.serviceKey,
          intervalMiles: i.intervalMiles,
          dueAtMiles: i.dueAtMiles,
          lastMiles: i.last?.miles ?? null,
          lastDate: i.last?.date ?? null,
          lastSource: i.last?.source ?? null,
          usingShopInterval: i.usingShopInterval ?? false,
        })),
      } : null,
      rawHistory: rawHistory.slice(0, 100),
    }, { status: 200 });
  } catch (err: any) {
    console.error("[PlanBuild Diagnostics] Error:", err);
    return NextResponse.json({ error: "Diagnostics failed", details: err.message }, { status: 500 });
  }
}
