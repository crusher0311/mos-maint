#!/usr/bin/env npx tsx
// Protractor Sync Worker - runs continuously to sync recent work orders
// Usage: npx tsx scripts/protractor-sync-worker.ts

export {};

const BASE_SYNC_INTERVAL_MS = 10 * 1000; // 10 seconds
const MAX_SYNC_INTERVAL_MS = 120 * 1000; // 2 minutes max backoff
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 5000;
const RATE_LIMIT_BACKOFF_MS = 60000;

// Determine API URL based on environment
function getApiUrl(): string {
  // When running inside combined script or locally, always use localhost
  // This avoids health check interference on cloud platforms
  const port = process.env.PORT || 5000;
  const useLocalhost = process.env.USE_LOCALHOST_API === 'true' || 
                       (!process.env.PRODUCTION_URL && !process.env.REPLIT_DEV_DOMAIN);
  
  if (useLocalhost || process.env.COMBINED_SCRIPT === 'true') {
    return `http://localhost:${port}/api/cron/protractor-sync`;
  }
  // Production URL for external hosting (when running as separate service)
  if (process.env.PRODUCTION_URL) {
    return `${process.env.PRODUCTION_URL}/api/cron/protractor-sync`;
  }
  // Replit dev domain
  if (process.env.REPLIT_DEV_DOMAIN) {
    return `https://${process.env.REPLIT_DEV_DOMAIN}/api/cron/protractor-sync`;
  }
  return `http://localhost:${port}/api/cron/protractor-sync`;
}

const API_URL = getApiUrl();

let isRunning = false;
let consecutiveFailures = 0;
let totalSyncs = 0;
let successfulSyncs = 0;
let lastSyncDurationMs = 0;

function getAdaptiveInterval(): number {
  if (consecutiveFailures === 0) return BASE_SYNC_INTERVAL_MS;
  const backoffMultiplier = Math.min(Math.pow(2, consecutiveFailures), 12);
  return Math.min(BASE_SYNC_INTERVAL_MS * backoffMultiplier, MAX_SYNC_INTERVAL_MS);
}

async function runSync(): Promise<void> {
  if (isRunning) {
    console.log(`[${new Date().toISOString()}] Sync already in progress, skipping...`);
    return;
  }
  
  isRunning = true;
  const startTime = Date.now();
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Running Protractor sync...`);
  
  let lastError: Error | null = null;
  let success = false;
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(API_URL, {
        headers: {
          'Authorization': `Bearer ${process.env.CRON_SECRET || ''}`
        }
      });
      
      if (res.status === 429) {
        console.log(`[${timestamp}] Rate limited. Waiting ${RATE_LIMIT_BACKOFF_MS / 1000}s before retry...`);
        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_BACKOFF_MS));
        continue;
      }
      
      const text = await res.text();
      
      if (text.startsWith("<!DOCTYPE") || text.startsWith("<html")) {
        console.log(`[${timestamp}] Server not ready (HTML response). Will retry next interval.`);
        break;
      }
      
      const data = JSON.parse(text);
      
      if (res.ok) {
        const s = data.summary;
        console.log(`[${timestamp}] Sync complete: ${s?.totalSynced || 0} synced, ${s?.totalShops || 0} shops, ${data.duration}`);
        consecutiveFailures = 0;
        success = true;
        successfulSyncs++;
      } else {
        console.error(`[${timestamp}] Sync failed:`, data.error);
        consecutiveFailures++;
      }
      break;
      
    } catch (err: any) {
      lastError = err;
      console.error(`[${timestamp}] Attempt ${attempt}/${MAX_RETRIES} failed:`, err.message);
      
      if (attempt < MAX_RETRIES) {
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
        console.log(`[${timestamp}] Retrying in ${backoff / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
    }
  }
  
  totalSyncs++;
  lastSyncDurationMs = Date.now() - startTime;
  
  if (lastError && consecutiveFailures >= MAX_RETRIES) {
    console.error(`[${timestamp}] All retries exhausted. Consecutive failures: ${consecutiveFailures}`);
  }
  
  if (totalSyncs % 10 === 0) {
    const successRate = ((successfulSyncs / totalSyncs) * 100).toFixed(1);
    console.log(`[${timestamp}] Stats: ${successfulSyncs}/${totalSyncs} successful (${successRate}%), last duration: ${lastSyncDurationMs}ms`);
  }
  
  isRunning = false;
}

async function main(): Promise<void> {
  console.log('Protractor Sync Worker started');
  console.log(`Base sync interval: ${BASE_SYNC_INTERVAL_MS / 1000} seconds`);
  console.log(`Max retries: ${MAX_RETRIES}`);
  console.log(`API URL: ${API_URL}`);
  console.log('');
  
  await new Promise(resolve => setTimeout(resolve, 10000));
  
  while (true) {
    await runSync();
    const interval = getAdaptiveInterval();
    if (interval !== BASE_SYNC_INTERVAL_MS) {
      console.log(`[${new Date().toISOString()}] Adaptive backoff: waiting ${interval / 1000}s (${consecutiveFailures} consecutive failures)`);
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

main().catch(console.error);
