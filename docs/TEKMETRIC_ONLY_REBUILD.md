# Rebuilding MOS Maintenance for Tekmetric Only

This document provides a complete guide for rebuilding or deploying MOS Maintenance as a Tekmetric-only integration, removing dependencies on other shop management systems (Protractor, AutoFlow).

---

## Table of Contents

1. [Overview](#overview)
2. [Environment Variables](#environment-variables)
3. [Database Collections](#database-collections)
4. [Core Files to Keep](#core-files-to-keep)
5. [Files to Remove/Ignore](#files-to-removeignore)
6. [API Routes](#api-routes)
7. [Shop Configuration](#shop-configuration)
8. [Sync Architecture](#sync-architecture)
9. [Initial Setup Steps](#initial-setup-steps)
10. [Ongoing Sync](#ongoing-sync)
11. [Feature Compatibility](#feature-compatibility)

---

## Overview

The Tekmetric integration provides:
- OAuth-based authentication with automatic token refresh
- Vehicle, customer, and repair order syncing
- Canned jobs management
- Work order history indexing for job lookup
- Real-time webhook support
- Rate limiting with distributed slot management

---

## Environment Variables

### Required Secrets

| Variable | Description |
|----------|-------------|
| `TEKMETRIC_CLIENT_ID` | OAuth client ID from Tekmetric developer portal |
| `TEKMETRIC_CLIENT_SECRET` | OAuth client secret from Tekmetric developer portal |
| `MONGODB_USERNAME` | MongoDB Atlas username |
| `MONGODB_PASSWORD` | MongoDB Atlas password |
| `DATABASE_URL` | PostgreSQL connection string (if using Postgres features) |
| `OPENAI_API_KEY` | For AI-powered maintenance recommendations |
| `CRON_SECRET` | Secret for authenticating cron/sync endpoints |

### Optional Secrets

| Variable | Description |
|----------|-------------|
| `RESEND_API_KEY` | For email notifications |
| `STRIPE_SECRET_KEY` | For billing (if enabled) |
| `HOVERCODE_API_TOKEN` | For QR code generation (oil stickers) |

### Note on TEKMETRIC_API_TOKEN

The legacy `TEKMETRIC_API_TOKEN` is no longer used. The system now uses OAuth client credentials (`TEKMETRIC_CLIENT_ID` and `TEKMETRIC_CLIENT_SECRET`) which auto-refresh tokens stored in the `tekmetric_tokens` collection.

---

## Database Collections

### MongoDB Collections for Tekmetric

| Collection | Purpose |
|------------|---------|
| `shops` | Shop configuration with `tekmetric.shopId` field |
| `vehicles` | Normalized vehicle records |
| `customers` | Customer information linked to vehicles |
| `sms_historical_work_orders` | Historical repair orders from Tekmetric |
| `job_index` | Indexed jobs for AI-powered job lookup |
| `tekmetric_tokens` | OAuth token storage with auto-refresh |
| `tekmetric_sync_state` | Per-shop sync state (last sync time, cursor) |
| `api_usage_log` | API request tracking and rate limiting |
| `rate_limit_slots` | Distributed rate limit slot management |

### Collections to Remove (Protractor/AutoFlow specific)

| Collection | Purpose (can be dropped for Tekmetric-only) |
|------------|---------------------------------------------|
| `protractor_cache` | Protractor API response cache |
| `protractor_canned_jobs_cache` | Protractor canned jobs cache |
| `autoflow_cache` | AutoFlow API response cache |
| `events` | AutoFlow webhook events |

---

## Core Files to Keep

### Library Files (`lib/`)

```
lib/tekmetric.ts                    # Main Tekmetric API client
lib/tekmetric-auth.ts               # OAuth token management
lib/tekmetric-sync.ts               # Sync orchestration
lib/tekmetric-incremental-sync.ts   # Incremental sync logic
lib/tekmetric-job-index.ts          # Job indexing for lookup
lib/tekmetric-usage-tracker.ts      # API usage tracking
lib/mongo.ts                        # MongoDB connection
lib/auth.ts                         # User authentication
lib/api-usage-tracker.ts            # Rate limiting
```

### API Routes (`app/api/`)

```
app/api/tekmetric/                  # Tekmetric API endpoints
  ├── sync/route.ts                 # Manual sync trigger
  ├── canned-jobs/route.ts          # Canned jobs management
  ├── labels/route.ts               # RO labels
  └── apply-canned-job/route.ts     # Apply canned job to RO

app/api/cron/
  ├── tekmetric-sync/route.ts           # Legacy sync endpoint
  ├── tekmetric-backfill/route.ts       # History backfill
  └── tekmetric-incremental-sync/route.ts # Incremental sync

app/api/settings/tekmetric/route.ts     # Shop settings
app/api/webhooks/tekmetric/route.ts     # Webhook receiver
app/api/platform-admin/tekmetric-usage/ # Usage monitoring
```

### Scripts (`scripts/`)

```
scripts/tekmetric-history-backfill.ts   # One-time history import
scripts/tekmetric-sync-worker.ts        # Continuous sync worker
scripts/tekmetric-backfill-worker.ts    # Background backfill
```

### Chrome Extension (`mos-tools-extension/`)

```
mos-tools-extension/adapters/tekmetric-content.js  # Tekmetric-specific adapter
```

---

## Files to Remove/Ignore

For a Tekmetric-only build, these can be removed or ignored:

### Protractor Files

```
lib/integrations/protractor.ts
app/api/protractor/
app/api/cron/protractor-sync/
app/api/cron/protractor-backfill/
scripts/protractor-*.ts
```

### AutoFlow Files

```
lib/integrations/autoflow.ts
app/api/autoflow/
```

### AutoVitals Files

```
lib/integrations/autovitals.ts
```

---

## API Routes

### Tekmetric API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/tekmetric/sync` | POST | Trigger manual sync for a shop |
| `/api/tekmetric/canned-jobs` | GET | List canned jobs |
| `/api/tekmetric/canned-jobs` | POST | Create/update canned job |
| `/api/tekmetric/labels` | GET | Get RO labels |
| `/api/tekmetric/apply-canned-job` | POST | Apply canned job to RO |
| `/api/settings/tekmetric` | GET/PUT | Shop Tekmetric settings |
| `/api/webhooks/tekmetric` | POST | Receive Tekmetric webhooks |

### Cron Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/cron/tekmetric-incremental-sync` | GET | Incremental sync (called by worker) |
| `/api/cron/tekmetric-backfill` | GET | History backfill trigger |

---

## Shop Configuration

### Shop Document Structure

```javascript
{
  _id: ObjectId,
  name: "Example Auto Shop",
  tekmetric: {
    shopId: 123,              // Tekmetric shop ID
    enabled: true,
    syncEnabled: true,
    lastSyncAt: ISODate(),
    webhookSecret: "...",     // For webhook verification
  },
  enabledFeatures: ["oil_sticker", "part_xref"],
  // Remove protractor and autoflow objects for Tekmetric-only
}
```

### Minimal Shop Setup

```javascript
await db.collection("shops").insertOne({
  name: "My Tekmetric Shop",
  tekmetric: {
    shopId: YOUR_TEKMETRIC_SHOP_ID,
    enabled: true,
    syncEnabled: true,
  },
  enabledFeatures: [],
  createdAt: new Date(),
  updatedAt: new Date(),
});
```

---

## Sync Architecture

### Token Management Flow

```
1. Request comes in
2. lib/tekmetric-auth.ts checks for valid cached token
3. If expired/missing, uses CLIENT_ID + CLIENT_SECRET to get new token
4. Token stored in tekmetric_tokens collection
5. Token cached in memory for 55 minutes
6. Automatic refresh before expiry
```

### Incremental Sync Flow

```
1. tekmetric-sync-worker.ts runs continuously
2. Calls /api/cron/tekmetric-incremental-sync every 60 seconds
3. For each shop with tekmetric.syncEnabled = true:
   a. Load last sync timestamp from tekmetric_sync_state
   b. Fetch repair orders updated since last sync
   c. Fetch associated vehicles, customers, jobs
   d. Upsert to MongoDB collections
   e. Update sync state with new timestamp
4. Adaptive backoff on failures (up to 5 minutes)
```

### History Backfill Flow

```
1. Run scripts/tekmetric-history-backfill.ts once per shop
2. Fetches up to 5 years of historical repair orders
3. Processes in batches with rate limiting (50ms delay)
4. Caches vehicles/customers to reduce API calls
5. Indexes jobs for job lookup feature
```

---

## Initial Setup Steps

### 1. Environment Setup

```bash
# Set required environment variables
export TEKMETRIC_CLIENT_ID="your-client-id"
export TEKMETRIC_CLIENT_SECRET="your-client-secret"
export MONGODB_USERNAME="your-mongo-user"
export MONGODB_PASSWORD="your-mongo-password"
export CRON_SECRET="random-secure-string"
```

### 2. Database Indexes

Run these MongoDB commands to create necessary indexes:

```javascript
// Vehicles
db.vehicles.createIndex({ shopId: 1, vin: 1 }, { unique: true });
db.vehicles.createIndex({ "sourceIds.tekmetric": 1 });

// Customers
db.customers.createIndex({ shopId: 1, email: 1 });
db.customers.createIndex({ "sourceIds.tekmetric": 1 });

// Work Orders
db.sms_historical_work_orders.createIndex({ shopId: 1, sourceProvider: 1 });
db.sms_historical_work_orders.createIndex({ "sourceId.tekmetric": 1 });
db.sms_historical_work_orders.createIndex({ updatedAt: -1 });

// Job Index
db.job_index.createIndex({ shopId: 1, "job.description": "text" });
db.job_index.createIndex({ shopId: 1, vehicleYmm: 1 });

// Sync State
db.tekmetric_sync_state.createIndex({ shopId: 1 }, { unique: true });

// Tokens
db.tekmetric_tokens.createIndex({ tokenKey: 1 }, { unique: true });
```

### 3. Configure Shop

```javascript
// Insert shop with Tekmetric config
await db.collection("shops").insertOne({
  name: "My Auto Shop",
  tekmetric: {
    shopId: 123,  // Get this from Tekmetric admin panel
    enabled: true,
    syncEnabled: true,
  },
  enabledFeatures: [],
  createdAt: new Date(),
});
```

### 4. Run History Backfill

```bash
npx tsx scripts/tekmetric-history-backfill.ts
```

### 5. Start Sync Worker

```bash
# Development
npx tsx scripts/tekmetric-sync-worker.ts

# Production (add to deployment)
# The worker runs as a background process alongside the main app
```

---

## Ongoing Sync

### Automatic Sync

The `tekmetric-sync-worker.ts` runs continuously and syncs every 60 seconds (with adaptive backoff on failures).

### Manual Sync

Trigger via API:

```bash
curl -X POST https://your-app.com/api/tekmetric/sync \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"shopId": "your-shop-id"}'
```

### Monitoring

Check sync health via:
- `tekmetric_sync_state` collection for last sync times
- `api_usage_log` collection for API call metrics
- Platform admin panel at `/platform-admin`

---

## Feature Compatibility

### Works with Tekmetric

| Feature | Status | Notes |
|---------|--------|-------|
| Dashboard | Full | Vehicle list, mileage tracking |
| Maintenance Plans | Full | AI-powered recommendations |
| Job Lookup | Full | Search historical jobs |
| Canned Jobs | Full | Manage and apply to ROs |
| Oil Stickers | Full | QR code generation |
| Quick Sticker | Full | Rapid sticker printing |
| Customer Data | Full | Name, phone, email |
| Vehicle History | Full | RO history from Tekmetric |

### Not Available (requires other integrations)

| Feature | Requires |
|---------|----------|
| CARFAX History | CARFAX API |
| Digital Inspections | AutoVitals |
| DVI Data | AutoFlow/AutoVitals |

---

## Removing Other Integrations

To completely remove Protractor/AutoFlow code:

### 1. Remove from package.json

No additional packages needed - Tekmetric uses standard fetch.

### 2. Update Sidebar.tsx

Remove Protractor/AutoFlow specific menu items (if any).

### 3. Update Shop Settings

Remove integration tabs for Protractor/AutoFlow in settings pages.

### 4. Clean Database

```javascript
// Optional: Remove unused collections
db.protractor_cache.drop();
db.protractor_canned_jobs_cache.drop();
db.autoflow_cache.drop();
db.events.drop();  // If only used for AutoFlow webhooks
```

---

## Deployment Notes

### Render.com Configuration

1. **Web Service**: Standard Next.js deployment
2. **Background Worker**: Add `scripts/tekmetric-sync-worker.ts` as a separate background worker
3. **Environment Variables**: Set all required secrets in Render dashboard
4. **Cron Jobs**: Optional - can also use Render cron for backfill triggers

### Health Checks

Monitor these for sync health:
- `/api/health` - General app health
- Check `tekmetric_sync_state` for sync timestamps
- Monitor `consecutiveFailures` in worker logs

---

## Troubleshooting

### Token Refresh Failures

```
Error: Failed to fetch Tekmetric token: 401
```

- Verify `TEKMETRIC_CLIENT_ID` and `TEKMETRIC_CLIENT_SECRET` are correct
- Check if credentials have been revoked in Tekmetric developer portal

### Rate Limiting

```
Rate limited. Waiting 60s before retry...
```

- Normal behavior - the system auto-backoffs
- Check `api_usage_log` for request patterns
- Consider increasing delay between requests if persistent

### Sync Not Running

1. Check `tekmetric.syncEnabled` is `true` for the shop
2. Verify worker process is running
3. Check for errors in worker logs
4. Verify `CRON_SECRET` matches in worker and API

### Missing Data

1. Run history backfill for comprehensive data
2. Check `tekmetric_sync_state` for last successful sync
3. Verify shop's `tekmetric.shopId` matches Tekmetric admin panel

---

## Support

For Tekmetric API questions:
- Tekmetric Developer Docs: https://developer.tekmetric.com/
- Tekmetric Support: support@tekmetric.com

For MOS Maintenance issues:
- Check logs in `/platform-admin`
- Review `tekmetric_sync_state` collection
- Contact development team
