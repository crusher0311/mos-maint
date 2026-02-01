export { buildRecommendations } from './build';

import sql from "@/lib/db/postgres";

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
  const vinUpper = vin.toUpperCase();
  
  const rows = await sql`
    SELECT id, oem_maintenance_schedule, declined_services
    FROM vehicles
    WHERE vin = ${vinUpper}
    LIMIT 1
  `;
  
  if (rows.length === 0) {
    return [];
  }
  
  const vehicle = rows[0];
  const recommendations: Recommendation[] = [];
  
  const oemSchedule = vehicle.oem_maintenance_schedule as any;
  if (oemSchedule?.items) {
    for (const item of oemSchedule.items) {
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
  
  const declinedServices = vehicle.declined_services as any[];
  if (declinedServices?.length) {
    for (const declined of declinedServices.slice(0, 5)) {
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
