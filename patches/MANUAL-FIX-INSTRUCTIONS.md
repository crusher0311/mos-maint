# Fix for Protractor Backfill Recursive Loop

## File: lib/integrations/protractor-backfill.ts

### Step 1: Find and DELETE this block (around line 489-499)

DELETE THESE LINES:
```javascript
    if (!complete) {
      console.log(`[Backfill] Shop ${shopId}: Not complete, starting next run immediately`);
      try {
        const nextResult = await runProtractorBackfill(shopId);
        console.log(`[Backfill] Shop ${shopId}: Next run result:`, nextResult.complete ? 'COMPLETE' : `${nextResult.chunksProcessed} more chunks`);
      } catch (err: any) {
        console.error(`[Backfill] Shop ${shopId}: Next run failed:`, err.message);
      }
    } else {
      console.log(`[Backfill] Shop ${shopId}: FULLY COMPLETE!`);
    }
```

REPLACE WITH:
```javascript
    console.log(`[Backfill] Shop ${shopId}: Run finished, complete: ${complete}`);
```

### Step 2: Find and DELETE this block (around line 517-527)

DELETE THESE LINES (the auto-retry block in the catch clause):
```javascript
    if (retryCount <= MAX_RETRIES) {
      const backoffMs = Math.min(30000, 5000 * retryCount);
      console.log(`[Backfill] Shop ${shopId}: Auto-retry ${retryCount}/${MAX_RETRIES} in ${backoffMs/1000}s...`);
      setTimeout(() => {
        runProtractorBackfill(shopId).catch(retryErr => {
          console.error(`[Backfill] Shop ${shopId}: Retry failed:`, retryErr.message);
        });
      }, backoffMs);
    } else {
      console.error(`[Backfill] Shop ${shopId}: Max retries (${MAX_RETRIES}) exceeded, giving up`);
    }
```

(Just delete it entirely, don't replace with anything)

### Why this fixes the issue

The recursive call `runProtractorBackfill(shopId)` was causing the backfill to run continuously without pause, resulting in 70k+ API calls. Removing it means the backfill will process one batch per cron trigger instead of looping infinitely.
