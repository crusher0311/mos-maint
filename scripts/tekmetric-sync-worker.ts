#!/usr/bin/env npx tsx
// Tekmetric Sync Worker - runs continuously to sync recent repair orders
// Usage: npx tsx scripts/tekmetric-sync-worker.ts

export {};

const BASE_SYNC_INTERVAL_MS = 10 * 1000; // 10 seconds
const MAX_SYNC_INTERVAL_MS = 120 * 1000; // 2 minutes max backoff
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 5000;
const RATE_LIMIT_BACKOFF_MS = 60000;

const API_URL = process.env.REPLIT_DEV_DOMAIN 
  ? `https://${process.env.REPLIT_DEV_DOMAIN}/api/cron/tekmetric-sync`
  : 'http://localhost:5000/api/cron/tekmetric-sync';

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
  console.log(`[${timestamp}] Running Tekmetric sync...`);
  
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
        console.log(`[${timestamp}] Sync complete:`, JSON.stringify(data, null, 2));
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
  console.log('Tekmetric Sync Worker started');
  console.log(`Base sync interval: ${BASE_SYNC_INTERVAL_MS / 1000} seconds`);
  console.log(`Max retries: ${MAX_RETRIES}`);
  console.log(`API URL: ${API_URL}`);
  console.log('');
  
  await new Promise(resolve => setTimeout(resolve, 15000));
  
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
