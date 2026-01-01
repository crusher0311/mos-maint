// Background worker for automatic Protractor job history backfill
// Runs continuously, processing a chunk every few minutes
// Usage: npx tsx scripts/protractor-backfill-worker.ts

const SYNC_INTERVAL = 5 * 60 * 1000; // 5 minutes between runs
const BACKFILL_API_URL = process.env.REPLIT_DEV_DOMAIN
  ? `https://${process.env.REPLIT_DEV_DOMAIN}/api/cron/protractor-backfill`
  : "http://localhost:5000/api/cron/protractor-backfill";

async function runBackfill() {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Running backfill...`);

  try {
    const res = await fetch(BACKFILL_API_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${process.env.CRON_SECRET || ""}`,
      },
    });

    const text = await res.text();
    
    // Check if response is HTML (server not ready or error page)
    if (text.startsWith("<!DOCTYPE") || text.startsWith("<html")) {
      console.log(`[${timestamp}] Server not ready yet (returned HTML). Will retry next interval.`);
      return;
    }
    
    try {
      const data = JSON.parse(text);
      console.log(`[${timestamp}] Backfill result:`, JSON.stringify(data, null, 2));

      if (data.shopsRemaining === 0) {
        console.log(`[${timestamp}] All shops backfilled! Worker can be stopped.`);
      }
    } catch (parseError) {
      console.error(`[${timestamp}] Failed to parse response:`, text.substring(0, 200));
    }
  } catch (error) {
    console.error(`[${timestamp}] Backfill error:`, error);
  }
}

async function main() {
  console.log("Protractor Backfill Worker started");
  console.log(`Sync interval: ${SYNC_INTERVAL / 1000 / 60} minutes`);
  console.log(`API URL: ${BACKFILL_API_URL}`);
  console.log("");

  // Run immediately on startup
  await runBackfill();

  // Then run on interval
  setInterval(runBackfill, SYNC_INTERVAL);
}

main();
