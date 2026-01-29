#!/usr/bin/env npx tsx
// Plan Prefetch Worker - keeps plan cache warm by prefetching recent vehicles
// Usage: npx tsx scripts/plan-prefetch-worker.ts

console.log("[PlanPrefetch] Script loaded");

export {};

const PREFETCH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const STARTUP_DELAY_MS = 2 * 60 * 1000; // Wait 2 minutes for server warmup
const MAX_VEHICLES_PER_SHOP = 15;
const DELAY_BETWEEN_VEHICLES = 500;
const INTERNAL_SECRET = process.env.INTERNAL_WORKER_SECRET || "mos-prefetch-worker-2024";

function getApiUrl(): string {
  const port = process.env.PORT || 5000;
  
  if (process.env.COMBINED_SCRIPT === 'true') {
    return `http://localhost:${port}`;
  }
  if (process.env.PRODUCTION_URL) {
    return process.env.PRODUCTION_URL;
  }
  return `http://localhost:${port}`;
}

const BASE_URL = getApiUrl();

let isRunning = false;
let totalCycles = 0;
let totalPrefetched = 0;

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runPrefetchCycle(): Promise<void> {
  if (isRunning) {
    console.log("[PlanPrefetch] Already running, skipping");
    return;
  }

  if (process.env.DISABLE_PLAN_PREFETCH === "true") {
    return;
  }

  isRunning = true;
  totalCycles++;
  const startTime = Date.now();
  let cyclePrefetched = 0;
  let cycleSkipped = 0;

  try {
    // Get all configured shops via internal endpoint (no auth required)
    const shopsRes = await fetch(`${BASE_URL}/api/internal/prefetch-shops`, {
      headers: { 
        'Content-Type': 'application/json',
        'x-internal-secret': INTERNAL_SECRET
      }
    });
    
    if (!shopsRes.ok) {
      console.log(`[PlanPrefetch] Could not fetch shops list: ${shopsRes.status}`);
      return;
    }

    const shopsData = await shopsRes.json();
    const shops = shopsData.shops || [];
    
    console.log(`[PlanPrefetch] Found ${shops.length} configured shops`);

    for (const shop of shops) {
      const shopId = shop.shopId;

      // Get recent vehicles for this shop via internal endpoint
      try {
        const dashRes = await fetch(`${BASE_URL}/api/internal/prefetch-vehicles?shopId=${shopId}&limit=50`, {
          headers: { 
            'Content-Type': 'application/json',
            'x-internal-secret': INTERNAL_SECRET
          }
        });

        if (!dashRes.ok) {
          console.log(`[PlanPrefetch] Shop ${shopId}: Failed to get vehicles (${dashRes.status})`);
          continue;
        }

        const dashData = await dashRes.json();
        const vehicles = (dashData.rows || [])
          .filter((r: any) => r.vin && r.vin.length === 17 && r.mileage)
          .slice(0, MAX_VEHICLES_PER_SHOP);
        
        console.log(`[PlanPrefetch] Shop ${shopId}: Processing ${vehicles.length} vehicles`);

        for (const vehicle of vehicles) {
          const vin = vehicle.vin;
          const mileage = typeof vehicle.mileage === 'number' ? vehicle.mileage :
                         parseInt(String(vehicle.mileage).replace(/,/g, ''), 10) || 0;

          if (!vin || !mileage) continue;

          try {
            const buildRes = await fetch(`${BASE_URL}/api/plan-build`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ vin, shopId, mileage }),
            });

            const buildData = await buildRes.json();
            if (buildData.cached) {
              cycleSkipped++;
            } else if (buildRes.ok) {
              cyclePrefetched++;
            }
          } catch {
            // Continue on errors
          }

          await sleep(DELAY_BETWEEN_VEHICLES);
        }
      } catch {
        // Continue to next shop
      }
    }

    const duration = Math.round((Date.now() - startTime) / 1000);
    totalPrefetched += cyclePrefetched;
    
    console.log(`[PlanPrefetch] Cycle ${totalCycles} complete: ${cyclePrefetched} new, ${cycleSkipped} cached (${duration}s)`);
  } catch (err: any) {
    console.error("[PlanPrefetch] Error:", err.message);
  } finally {
    isRunning = false;
  }
}

async function main(): Promise<void> {
  console.log("[PlanPrefetch] Worker starting...");
  console.log(`[PlanPrefetch] Will run every ${PREFETCH_INTERVAL_MS / 60000} minutes`);
  console.log(`[PlanPrefetch] Waiting ${STARTUP_DELAY_MS / 1000}s for server warmup...`);

  // Wait for server to warm up
  await sleep(STARTUP_DELAY_MS);

  // Run first cycle
  await runPrefetchCycle();

  // Schedule periodic runs
  setInterval(() => {
    runPrefetchCycle();
  }, PREFETCH_INTERVAL_MS);
}

main().catch((err) => {
  console.error("[PlanPrefetch] Fatal error:", err);
  process.exit(1);
});
