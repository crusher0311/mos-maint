#!/usr/bin/env npx ts-node
import "dotenv/config";

const API_BASE = process.env.PRODUCTION_URL || process.env.NEXT_PUBLIC_APP_URL || "https://mos.tools";
const ADMIN_SECRET = process.env.CRON_SECRET;

async function runGracePeriodCheck() {
  console.log(`[${new Date().toISOString()}] Running daily grace period check...`);
  console.log(`  API_BASE: ${API_BASE}`);
  
  try {
    const response = await fetch(`${API_BASE}/api/admin/billing/grace-period-check`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(ADMIN_SECRET ? { "Authorization": `Bearer ${ADMIN_SECRET}` } : {}),
      },
    });
    
    if (!response.ok) {
      const text = await response.text();
      console.error(`[ERROR] Grace period check HTTP ${response.status}: ${text}`);
      return false;
    }
    
    const result = await response.json();
    console.log(`[SUCCESS] Grace period check completed:`);
    console.log(`  - Shops transitioned to suspended: ${result.transitioned?.length || 0}`);
    console.log(`  - Reminder emails sent: ${result.remindersSent || 0}`);
    
    if (result.transitioned?.length > 0) {
      console.log(`  - Suspended shops:`);
      result.transitioned.forEach((shop: any) => {
        console.log(`    - ${shop.shopName} (ID: ${shop.shopId})`);
      });
    }
    
    return true;
  } catch (error) {
    console.error(`[ERROR] Failed to run grace period check:`, error);
    return false;
  }
}

async function runProtractorSync() {
  console.log(`[${new Date().toISOString()}] Running Protractor daily sync...`);
  
  try {
    const response = await fetch(`${API_BASE}/api/cron/protractor-sync`, {
      method: "GET",
      headers: {
        ...(ADMIN_SECRET ? { "Authorization": `Bearer ${ADMIN_SECRET}` } : {}),
      },
    });
    
    if (!response.ok) {
      const text = await response.text();
      console.error(`[ERROR] Protractor sync HTTP ${response.status}: ${text}`);
      return false;
    }
    
    const result = await response.json();
    
    if (result.disabled) {
      console.log(`[INFO] Protractor sync is disabled: ${result.message}`);
      return true;
    }
    
    console.log(`[SUCCESS] Protractor sync completed in ${result.duration}:`);
    if (result.shops?.length > 0) {
      result.shops.forEach((shop: any) => {
        if (shop.error) {
          console.log(`  - Shop ${shop.shopId}: ERROR - ${shop.error}`);
        } else {
          console.log(`  - Shop ${shop.shopId}: synced ${shop.synced} WOs, removed ${shop.removed}, vehicles updated ${shop.vehiclesUpdated || 0}`);
        }
      });
    } else {
      console.log(`  - No Protractor shops found`);
    }
    
    return true;
  } catch (error) {
    console.error(`[ERROR] Failed to run Protractor sync:`, error);
    return false;
  }
}

async function main() {
  console.log(`========================================`);
  console.log(`[${new Date().toISOString()}] Daily cron job starting`);
  console.log(`  API_BASE: ${API_BASE}`);
  console.log(`  CRON_SECRET set: ${!!ADMIN_SECRET}`);
  console.log(`========================================`);
  
  const graceResult = await runGracePeriodCheck();
  const protractorResult = await runProtractorSync();
  
  console.log(`========================================`);
  console.log(`[${new Date().toISOString()}] Daily cron job complete`);
  console.log(`  Grace period check: ${graceResult ? "OK" : "FAILED"}`);
  console.log(`  Protractor sync: ${protractorResult ? "OK" : "FAILED"}`);
  console.log(`========================================`);
  
  if (!graceResult && !protractorResult) {
    process.exit(1);
  }
}

main();
