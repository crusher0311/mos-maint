#!/usr/bin/env npx ts-node
import "dotenv/config";

const API_BASE = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:5000";
const ADMIN_SECRET = process.env.CRON_SECRET;

async function runGracePeriodCheck() {
  console.log(`[${new Date().toISOString()}] Running daily grace period check...`);
  
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
      console.error(`[ERROR] HTTP ${response.status}: ${text}`);
      process.exit(1);
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
    
  } catch (error) {
    console.error(`[ERROR] Failed to run grace period check:`, error);
    process.exit(1);
  }
}

runGracePeriodCheck();
