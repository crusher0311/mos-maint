import { getDb } from "@/lib/data/db";
import { drainAutoflowDashboardUpdates } from "@/lib/autoflow-dashboard-outbox";

/**
 * Scheduler entry point: keep database acquisition behind the repository
 * boundary, while the drain accepts a Db for webhook reuse and offline tests.
 */
export async function retryAutoflowDashboardNotifications(): Promise<number> {
  return drainAutoflowDashboardUpdates(await getDb());
}