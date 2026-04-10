import { Db } from "mongodb";

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function searchNormalizedCollections(
  db: Db | any,
  searchShopIds: number[],
  coreTokens: string[],
  vehicleMake?: string,
  limit: number = 50,
  vehicleModel?: string,
  strictModel: boolean = false,
): Promise<any[]> {
  if (coreTokens.length === 0) return [];

  try {
    const normalizedShopIdVariants = searchShopIds.flatMap(id => [Number(id), String(id)]);
    const shopMatch = searchShopIds.length === 1 
      ? { shopId: { $in: [Number(searchShopIds[0]), String(searchShopIds[0])] } }
      : { shopId: { $in: normalizedShopIdVariants } };

    const tokenConditions = coreTokens.map(t => {
      const regex = { $regex: new RegExp(escapeRegex(t), 'i') };
      return {
        $or: [
          { title: regex },
          { description: regex },
          { cannedJobName: regex },
        ]
      };
    });

    const serviceJobsPipeline: any[] = [
      {
        $match: {
          ...shopMatch,
          deletedAt: null,
          $and: tokenConditions
        }
      },
      { $sort: { createdAt: -1 } },
      { $limit: limit * 2 },
      {
        $lookup: {
          from: 'normalized_work_orders',
          localField: 'workOrderId',
          foreignField: '_id',
          as: 'workOrder'
        }
      },
      { $unwind: { path: '$workOrder', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'normalized_vehicles',
          localField: 'workOrder.vehicleId',
          foreignField: '_id',
          as: 'vehicle'
        }
      },
      { $unwind: { path: '$vehicle', preserveNullAndEmptyArrays: true } },
    ];

    if (vehicleMake) {
      serviceJobsPipeline.push({
        $match: { 'vehicle.make': { $regex: new RegExp(escapeRegex(vehicleMake), 'i') } }
      });
    }

    if (strictModel && vehicleModel) {
      serviceJobsPipeline.push({
        $match: { 'vehicle.model': { $regex: new RegExp(`^${escapeRegex(vehicleModel)}$`, 'i') } }
      });
    }

    serviceJobsPipeline.push({ $limit: limit });

    const normalizedJobs = await db.collection('normalized_service_jobs')
      .aggregate(serviceJobsPipeline)
      .toArray();

    return normalizedJobs.map((nj: any) => ({
      _id: nj._id,
      shopId: nj.shopId,
      vin: nj.vehicle?.vin,
      vehicle: {
        vin: nj.vehicle?.vin,
        year: nj.vehicle?.year,
        make: nj.vehicle?.make,
        model: nj.vehicle?.model,
        engine: nj.vehicle?.engine?.description,
      },
      job: {
        title: nj.title,
        description: nj.description,
        name: nj.cannedJobName || nj.title,
        keywords: [],
      },
      lines: (nj.lineItems || []).map((li: any) => ({
        lineType: li.itemType,
        description: li.description,
        partNumber: li.partNumber,
        qty: li.quantity,
        unitPrice: li.unitPrice,
        total: li.totalPrice,
      })),
      performedAt: nj.workOrder?.completedDate || nj.createdAt,
      workOrderId: nj.workOrderId,
      sourceSystem: nj.provenance?.sourceSystem || 'normalized',
    }));
  } catch (err) {
    console.log('[Jobs Search] Normalized search error:', (err as Error).message);
    return [];
  }
}
