const SYNC_INTERVAL_MS = 60 * 1000;
const API_URL = process.env.REPLIT_DEV_DOMAIN 
  ? `https://${process.env.REPLIT_DEV_DOMAIN}/api/cron/protractor-sync`
  : 'http://localhost:5000/api/cron/protractor-sync';

async function runSync() {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Running Protractor sync...`);
  
  try {
    const res = await fetch(API_URL, {
      headers: {
        'Authorization': `Bearer ${process.env.CRON_SECRET || ''}`
      }
    });
    
    const data = await res.json();
    
    if (res.ok) {
      console.log(`[${timestamp}] Sync complete:`, JSON.stringify(data, null, 2));
    } else {
      console.error(`[${timestamp}] Sync failed:`, data.error);
    }
  } catch (err: any) {
    console.error(`[${timestamp}] Sync error:`, err.message);
  }
}

async function main() {
  console.log('Protractor Sync Worker started');
  console.log(`Sync interval: ${SYNC_INTERVAL_MS / 1000} seconds`);
  console.log(`API URL: ${API_URL}`);
  
  await new Promise(resolve => setTimeout(resolve, 10000));
  
  while (true) {
    await runSync();
    await new Promise(resolve => setTimeout(resolve, SYNC_INTERVAL_MS));
  }
}

main().catch(console.error);
