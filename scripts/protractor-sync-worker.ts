#!/usr/bin/env npx tsx
// Protractor Callback-Driven Sync Worker
// Processes callbacks frequently, full sync less often
// Usage: npx tsx scripts/protractor-sync-worker.ts

export {};

const CALLBACK_SYNC_INTERVAL_MS = 5 * 1000; // 5 seconds - process pending callbacks
const FULL_SYNC_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes - full reconciliation
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 5000;
const RATE_LIMIT_BACKOFF_MS = 60000;

function getApiUrl(endpoint: string): string {
  const port = process.env.PORT || 5000;
  const useLocalhost = process.env.USE_LOCALHOST_API === 'true' || 
                       (!process.env.PRODUCTION_URL && !process.env.REPLIT_DEV_DOMAIN);
  
  if (useLocalhost || process.env.COMBINED_SCRIPT === 'true') {
    return `http://localhost:${port}${endpoint}`;
  }
  if (process.env.PRODUCTION_URL) {
    return `${process.env.PRODUCTION_URL}${endpoint}`;
  }
  if (process.env.REPLIT_DEV_DOMAIN) {
    return `https://${process.env.REPLIT_DEV_DOMAIN}${endpoint}`;
  }
  return `http://localhost:${port}${endpoint}`;
}

const CALLBACK_SYNC_URL = getApiUrl('/api/cron/protractor-callback-sync');
const FULL_SYNC_URL = getApiUrl('/api/cron/protractor-sync');

let isRunning = false;
let consecutiveFailures = 0;
let totalCallbackSyncs = 0;
let totalFullSyncs = 0;
let successfulCallbackSyncs = 0;
let successfulFullSyncs = 0;
let lastFullSyncTime = 0;

async function runCallbackSync(): Promise<{ processed: number }> {
  try {
    const res = await fetch(CALLBACK_SYNC_URL, {
      headers: {
        'Authorization': `Bearer ${process.env.CRON_SECRET || ''}`
      }
    });
    
    if (res.status === 429) {
      console.log(`[Callback Sync] Rate limited`);
      return { processed: 0 };
    }
    
    const text = await res.text();
    if (text.startsWith("<!DOCTYPE") || text.startsWith("<html")) {
      return { processed: 0 };
    }
    
    const data = JSON.parse(text);
    
    if (res.ok && data.processed > 0) {
      console.log(`[Callback Sync] Processed ${data.processed} items (${data.successful} successful) in ${data.duration}`);
      successfulCallbackSyncs++;
    }
    
    totalCallbackSyncs++;
    return { processed: data.processed || 0 };
  } catch (err: any) {
    console.error(`[Callback Sync] Error:`, err.message);
    return { processed: 0 };
  }
}

async function runFullSync(): Promise<void> {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Running full Protractor sync...`);
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(FULL_SYNC_URL, {
        headers: {
          'Authorization': `Bearer ${process.env.CRON_SECRET || ''}`
        }
      });
      
      if (res.status === 429) {
        console.log(`[${timestamp}] Rate limited. Waiting ${RATE_LIMIT_BACKOFF_MS / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_BACKOFF_MS));
        continue;
      }
      
      const text = await res.text();
      if (text.startsWith("<!DOCTYPE") || text.startsWith("<html")) {
        console.log(`[${timestamp}] Server not ready`);
        break;
      }
      
      const data = JSON.parse(text);
      
      if (res.ok) {
        console.log(`[${timestamp}] Full sync complete in ${data.duration}:`, 
          data.shops?.map((s: any) => `shop ${s.shopId}: ${s.synced} synced`).join(', ') || 'no data');
        consecutiveFailures = 0;
        successfulFullSyncs++;
      } else {
        console.error(`[${timestamp}] Full sync failed:`, data.error);
        consecutiveFailures++;
      }
      break;
      
    } catch (err: any) {
      console.error(`[${timestamp}] Attempt ${attempt}/${MAX_RETRIES} failed:`, err.message);
      
      if (attempt < MAX_RETRIES) {
        const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
    }
  }
  
  totalFullSyncs++;
  lastFullSyncTime = Date.now();
}

async function main(): Promise<void> {
  console.log('Protractor Callback-Driven Sync Worker started');
  console.log(`Callback sync interval: ${CALLBACK_SYNC_INTERVAL_MS / 1000} seconds`);
  console.log(`Full sync interval: ${FULL_SYNC_INTERVAL_MS / 1000 / 60} minutes`);
  console.log(`Callback sync URL: ${CALLBACK_SYNC_URL}`);
  console.log(`Full sync URL: ${FULL_SYNC_URL}`);
  console.log('');
  
  // Wait for server to start
  await new Promise(resolve => setTimeout(resolve, 15000));
  
  // Run initial full sync
  await runFullSync();
  
  while (true) {
    // Check if full sync is due
    const timeSinceFullSync = Date.now() - lastFullSyncTime;
    if (timeSinceFullSync >= FULL_SYNC_INTERVAL_MS) {
      await runFullSync();
    }
    
    // Process pending callbacks
    if (!isRunning) {
      isRunning = true;
      await runCallbackSync();
      isRunning = false;
    }
    
    // Log stats periodically
    if ((totalCallbackSyncs + totalFullSyncs) % 50 === 0 && totalCallbackSyncs > 0) {
      console.log(`[Stats] Callback syncs: ${successfulCallbackSyncs}/${totalCallbackSyncs}, Full syncs: ${successfulFullSyncs}/${totalFullSyncs}`);
    }
    
    await new Promise(resolve => setTimeout(resolve, CALLBACK_SYNC_INTERVAL_MS));
  }
}

main().catch(console.error);
