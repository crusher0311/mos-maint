export { buildRecommendations } from './build';

interface RecommendationOptions {
  shopId: string;
  mileage?: number;
  includeAI?: boolean;
}

interface Recommendation {
  service: string;
  priority: 'high' | 'medium' | 'low';
  source: string;
  reason?: string;
}

export async function getMaintenanceRecommendations(
  vin: string,
  options: RecommendationOptions
): Promise<Recommendation[]> {
  const { getDb } = await import('@/lib/mongo');
  const db = await getDb();
  
  const vehicle = await db.collection('vehicles').findOne({
    vin: vin.toUpperCase(),
  });
  
  if (!vehicle) {
    return [];
  }
  
  const recommendations: Recommendation[] = [];
  
  if (vehicle.oemMaintenanceSchedule?.items) {
    for (const item of vehicle.oemMaintenanceSchedule.items) {
      if (options.mileage && item.mileage && item.mileage <= options.mileage) {
        recommendations.push({
          service: item.description || item.service,
          priority: item.mileage > options.mileage - 5000 ? 'high' : 'medium',
          source: 'oem',
          reason: `Due at ${item.mileage.toLocaleString()} miles`,
        });
      }
    }
  }
  
  if (vehicle.declinedServices?.length) {
    for (const declined of vehicle.declinedServices.slice(0, 5)) {
      recommendations.push({
        service: declined.service,
        priority: 'medium',
        source: 'declined',
        reason: `Previously declined on ${new Date(declined.declinedAt).toLocaleDateString()}`,
      });
    }
  }
  
  return recommendations;
}
