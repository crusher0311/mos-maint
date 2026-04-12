import { getDb } from "@/lib/db/drizzle";
import { normalizedServiceJobs, normalizedWorkOrders, normalizedLineItems } from "@/lib/db/schema/normalized";
import { eq, and, inArray, ilike, sql, desc, isNull, or } from "drizzle-orm";

export async function searchSupabaseServiceJobs(
  searchShopIds: number[],
  coreTokens: string[],
  vehicleMake?: string,
  limit: number = 50,
  vehicleModel?: string,
  strictModel: boolean = false,
): Promise<any[]> {
  if (coreTokens.length === 0 || searchShopIds.length === 0) return [];

  try {
    const db = getDb();

    const tokenConditions = coreTokens.map(token => {
      const pattern = `%${token}%`;
      return or(
        ilike(normalizedServiceJobs.title, pattern),
        ilike(normalizedServiceJobs.description, pattern),
        ilike(normalizedServiceJobs.cannedJobName, pattern),
      );
    });

    const conditions = [
      inArray(normalizedServiceJobs.shopId, searchShopIds),
      sql`(${normalizedServiceJobs.softDelete}->>'isDeleted')::boolean = false`,
      ...tokenConditions.filter(Boolean) as any[],
    ];

    const serviceJobs = await db
      .select({
        id: normalizedServiceJobs.id,
        shopId: normalizedServiceJobs.shopId,
        workOrderId: normalizedServiceJobs.workOrderId,
        title: normalizedServiceJobs.title,
        description: normalizedServiceJobs.description,
        cannedJobName: normalizedServiceJobs.cannedJobName,
        laborTotal: normalizedServiceJobs.laborTotal,
        partsTotal: normalizedServiceJobs.partsTotal,
        total: normalizedServiceJobs.total,
        laborHoursBilled: normalizedServiceJobs.laborHoursBilled,
        laborHoursActual: normalizedServiceJobs.laborHoursActual,
        provenance: normalizedServiceJobs.provenance,
        createdAt: normalizedServiceJobs.createdAt,
        woNumber: normalizedWorkOrders.workOrderNumber,
        woVehicle: normalizedWorkOrders.vehicle,
        woVehicleId: normalizedWorkOrders.vehicleId,
        woCompletedDate: normalizedWorkOrders.completedDate,
        woClosedDate: normalizedWorkOrders.closedDate,
      })
      .from(normalizedServiceJobs)
      .innerJoin(
        normalizedWorkOrders,
        eq(normalizedServiceJobs.workOrderId, normalizedWorkOrders.id)
      )
      .where(and(...conditions))
      .orderBy(desc(normalizedServiceJobs.createdAt))
      .limit(limit * 2);

    let filtered = serviceJobs;

    if (vehicleMake) {
      const makeLower = vehicleMake.toLowerCase();
      filtered = filtered.filter(sj => {
        const v = sj.woVehicle as any;
        return v?.make && v.make.toLowerCase().includes(makeLower);
      });
    }

    if (strictModel && vehicleModel) {
      const modelLower = vehicleModel.toLowerCase();
      filtered = filtered.filter(sj => {
        const v = sj.woVehicle as any;
        return v?.model && v.model.toLowerCase() === modelLower;
      });
    }

    filtered = filtered.slice(0, limit);

    const lineItemsByJob = new Map<string, any[]>();
    if (filtered.length > 0) {
      const jobIds = filtered.map(sj => sj.id);
      try {
        const lines = await db
          .select({
            serviceJobId: normalizedLineItems.serviceJobId,
            lineType: normalizedLineItems.lineType,
            partDescription: normalizedLineItems.partDescription,
            partNumber: normalizedLineItems.partNumber,
            partManufacturer: normalizedLineItems.partManufacturer,
            quantity: normalizedLineItems.quantity,
            unitCost: normalizedLineItems.unitCost,
            unitPrice: normalizedLineItems.unitPrice,
            extendedPrice: normalizedLineItems.extendedPrice,
            laborHours: normalizedLineItems.laborHours,
          })
          .from(normalizedLineItems)
          .where(inArray(normalizedLineItems.serviceJobId, jobIds));

        for (const line of lines) {
          const existing = lineItemsByJob.get(line.serviceJobId) || [];
          existing.push(line);
          lineItemsByJob.set(line.serviceJobId, existing);
        }
      } catch (lineErr) {
        console.log("[Supabase Job Search] Line items fetch failed (non-blocking):", (lineErr as Error).message);
      }
    }

    return filtered.map(sj => {
      const vehicle = sj.woVehicle as any;
      const prov = sj.provenance as any;
      const rawLines = lineItemsByJob.get(sj.id) || [];

      return {
        _id: sj.id,
        shopId: sj.shopId,
        vin: vehicle?.vin,
        vehicle: {
          vin: vehicle?.vin,
          year: vehicle?.year,
          make: vehicle?.make,
          model: vehicle?.model,
          engine: vehicle?.engineDescription || vehicle?.engine,
        },
        job: {
          title: sj.title,
          description: sj.description,
          name: sj.cannedJobName || sj.title,
          keywords: [],
          totals: {
            laborAmount: parseFloat(String(sj.laborTotal)) || 0,
            partsAmount: parseFloat(String(sj.partsTotal)) || 0,
            totalAmount: parseFloat(String(sj.total)) || 0,
            laborHours: parseFloat(String(sj.laborHoursBilled || sj.laborHoursActual || 0)) || 0,
          },
        },
        lines: rawLines.map(li => ({
          lineType: li.lineType,
          description: li.partDescription,
          partNumber: li.partNumber,
          manufacturer: li.partManufacturer,
          quantity: parseFloat(String(li.quantity)) || 1,
          unitPrice: parseFloat(String(li.unitPrice)) || 0,
          extendedPrice: parseFloat(String(li.extendedPrice)) || 0,
          cost: parseFloat(String(li.unitCost)) || 0,
          hours: parseFloat(String(li.laborHours)) || 0,
        })),
        totals: {
          laborAmount: parseFloat(String(sj.laborTotal)) || 0,
          partsAmount: parseFloat(String(sj.partsTotal)) || 0,
          totalAmount: parseFloat(String(sj.total)) || 0,
          laborHours: parseFloat(String(sj.laborHoursBilled || sj.laborHoursActual || 0)) || 0,
        },
        performedAt: sj.woCompletedDate || sj.woClosedDate || sj.createdAt,
        workOrderId: sj.workOrderId,
        workOrderNumber: sj.woNumber,
        sourceSystem: prov?.sourceSystem || "unknown",
        dataSource: "supabase",
      };
    });
  } catch (err) {
    console.log("[Supabase Job Search] Error:", (err as Error).message);
    return [];
  }
}
