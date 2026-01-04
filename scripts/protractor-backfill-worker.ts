#!/usr/bin/env npx tsx
// Protractor Backfill Worker - processes historical job data in chunks
// Usage: npx tsx scripts/protractor-backfill-worker.ts

export {};

const SYNC_INTERVAL_MS = 10 * 1000; // 10 seconds between runs (maximum speed backfill)
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 10000;
const RATE_LIMIT_BACKOFF_MS = 120000;

const API_URL = process.env.REPLIT_DEV_DOMAIN
  ? `https://${process.env.REPLIT_DEV_DOMAIN}/api/cron/protractor-backfill`
  : "http://localhost:5000/api/cron/protractor-backfill";

let isRunning = false;
let consecutiveFailures = 0;

async function runBackfill(): Promise<void> {
  if (isRunning) {
    console.log(`[${new Date().toISOString()}] Backfill already in progress, skipping...`);
    return;
  }
  
  isRunning = true;
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Running Protractor backfill...`);

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(API_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${process.env.CRON_SECRET || ""}`,
        },
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
      console.log(`[${timestamp}] Backfill result:`, JSON.stringify(data, null, 2));

      if (data.shopsRemaining === 0) {
        console.log(`[${timestamp}] All Protractor shops backfilled! Exiting worker.`);
        process.exit(0);
      }
      
      consecutiveFailures = 0;
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
  
  if (lastError) {
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_RETRIES) {
      console.error(`[${timestamp}] All retries exhausted. Consecutive failures: ${consecutiveFailures}`);
    }
  }

  isRunning = false;
}

async function main(): Promise<void> {
  console.log("Protractor Backfill Worker started");
  console.log(`Sync interval: ${SYNC_INTERVAL_MS / 1000 / 60} minutes`);
  console.log(`Max retries: ${MAX_RETRIES}`);
  console.log(`API URL: ${API_URL}`);
  console.log("");

  await runBackfill();

  while (true) {
    await new Promise(resolve => setTimeout(resolve, SYNC_INTERVAL_MS));
    await runBackfill();
  }
}

main().catch(console.error);
