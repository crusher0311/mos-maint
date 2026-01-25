import { getDb } from './mongo';
import { createLogger } from './logger';

const logger = createLogger('db-indexes');

interface IndexDefinition {
  collection: string;
  name: string;
  keys: Record<string, 1 | -1 | 'text'>;
  options?: {
    unique?: boolean;
    sparse?: boolean;
    expireAfterSeconds?: number;
    background?: boolean;
  };
}

const indexes: IndexDefinition[] = [
  {
    collection: 'job_index',
    name: 'job_index_shop_vin',
    keys: { shopId: 1, 'vehicle.vin': 1 },
  },
  {
    collection: 'job_index',
    name: 'job_index_shop_serviceItemId',
    keys: { shopId: 1, 'vehicle.serviceItemId': 1 },
  },
  {
    collection: 'job_index',
    name: 'job_index_shop_closedAt',
    keys: { shopId: 1, closedAt: -1 },
  },
  {
    collection: 'job_index',
    name: 'job_index_shop_title',
    keys: { shopId: 1, title: 1 },
  },
  {
    collection: 'job_index',
    name: 'job_index_text_search',
    keys: { title: 'text', 'vehicle.vin': 'text' },
  },
  {
    collection: 'vehicle_cache',
    name: 'vehicle_cache_shopId_vin',
    keys: { shopId: 1, vin: 1 },
    options: { unique: true },
  },
  {
    collection: 'vehicle_cache',
    name: 'vehicle_cache_shopId_serviceItemId',
    keys: { shopId: 1, serviceItemId: 1 },
    options: { sparse: true },
  },
  {
    collection: 'vehicle_cache',
    name: 'vehicle_cache_updatedAt',
    keys: { updatedAt: -1 },
  },
  {
    collection: 'work_orders',
    name: 'work_orders_shopId_closedAt',
    keys: { shopId: 1, closedAt: -1 },
  },
  {
    collection: 'work_orders',
    name: 'work_orders_shopId_vehicleVin',
    keys: { shopId: 1, 'vehicle.vin': 1 },
  },
  {
    collection: 'work_orders',
    name: 'work_orders_shopId_number',
    keys: { shopId: 1, workOrderNumber: 1 },
    options: { unique: true, sparse: true },
  },
  {
    collection: 'shops',
    name: 'shops_shopId',
    keys: { shopId: 1 },
    options: { unique: true },
  },
  {
    collection: 'shops',
    name: 'shops_stripeCustomerId',
    keys: { stripeCustomerId: 1 },
    options: { sparse: true },
  },
  {
    collection: 'users',
    name: 'users_email',
    keys: { email: 1 },
    options: { unique: true },
  },
  {
    collection: 'users',
    name: 'users_shopId',
    keys: { shopId: 1 },
  },
  {
    collection: 'sync_state',
    name: 'sync_state_shopId_provider',
    keys: { shopId: 1, provider: 1 },
    options: { unique: true },
  },
  {
    collection: 'api_usage',
    name: 'api_usage_timestamp',
    keys: { timestamp: -1 },
  },
  {
    collection: 'api_usage',
    name: 'api_usage_provider_timestamp',
    keys: { provider: 1, timestamp: -1 },
  },
  {
    collection: 'api_usage',
    name: 'api_usage_shopId_timestamp',
    keys: { shopId: 1, timestamp: -1 },
  },
  {
    collection: 'api_usage',
    name: 'api_usage_ttl',
    keys: { timestamp: 1 },
    options: { expireAfterSeconds: 60 * 60 * 24 * 90 },
  },
  {
    collection: 'support_tickets',
    name: 'support_tickets_shopId_status',
    keys: { shopId: 1, status: 1 },
  },
  {
    collection: 'support_tickets',
    name: 'support_tickets_createdAt',
    keys: { createdAt: -1 },
  },
  {
    collection: 'notifications',
    name: 'notifications_userId_read',
    keys: { userId: 1, read: 1 },
  },
  {
    collection: 'notifications',
    name: 'notifications_createdAt',
    keys: { createdAt: -1 },
  },
  {
    collection: 'admin_audit_logs',
    name: 'audit_logs_createdAt',
    keys: { createdAt: -1 },
  },
  {
    collection: 'admin_audit_logs',
    name: 'audit_logs_adminEmail',
    keys: { adminEmail: 1, createdAt: -1 },
  },
  {
    collection: 'tekmetric_tokens',
    name: 'tekmetric_tokens_key',
    keys: { key: 1 },
    options: { unique: true },
  },
  {
    collection: 'vin_billing',
    name: 'vin_billing_shopId_month',
    keys: { shopId: 1, billingMonth: 1 },
  },
  {
    collection: 'vin_billing',
    name: 'vin_billing_vin',
    keys: { vin: 1 },
  },
  {
    collection: 'job_index',
    name: 'job_index_shop_customer_date',
    keys: { shopId: 1, customerId: 1, closedAt: -1 },
  },
  {
    collection: 'job_index',
    name: 'job_index_shop_performedAt',
    keys: { shopId: 1, performedAt: -1 },
  },
  {
    collection: 'vehicle_cache',
    name: 'vehicle_cache_shopId_customerId',
    keys: { shopId: 1, customerId: 1 },
  },
  {
    collection: 'work_orders',
    name: 'work_orders_shopId_status',
    keys: { shopId: 1, status: 1, closedAt: -1 },
  },
  {
    collection: 'work_orders',
    name: 'work_orders_shopId_customerId',
    keys: { shopId: 1, customerId: 1 },
  },
  {
    collection: 'shop_repair_patterns',
    name: 'repair_patterns_shop_ymm',
    keys: { shopId: 1, year: 1, make: 1, model: 1 },
  },
  {
    collection: 'shop_repair_patterns',
    name: 'repair_patterns_shop_mileage_job',
    keys: { shopId: 1, mileageBucket: 1, jobTitleNormalized: 1 },
  },
  {
    collection: 'shop_repair_patterns',
    name: 'repair_patterns_occurrences',
    keys: { shopId: 1, occurrences: -1 },
  },
  {
    collection: 'ratelimits',
    name: 'ratelimits_bucketKey',
    keys: { bucketKey: 1 },
  },
  {
    collection: 'ratelimits',
    name: 'ratelimits_ttl',
    keys: { expiresAt: 1 },
    options: { expireAfterSeconds: 0 },
  },
  {
    collection: 'sticker_prints',
    name: 'sticker_prints_shopId_vin',
    keys: { shopId: 1, vin: 1, printedAt: -1 },
  },
  {
    collection: 'auto_booking_queue',
    name: 'auto_booking_shopId_status',
    keys: { shopId: 1, status: 1, scheduledFor: 1 },
  },
];

export async function ensureIndexes(): Promise<{ created: number; existing: number; errors: string[] }> {
  const db = await getDb();
  let created = 0;
  let existing = 0;
  const errors: string[] = [];

  for (const indexDef of indexes) {
    try {
      const collection = db.collection(indexDef.collection);
      
      const existingIndexes = await collection.indexes();
      const indexExists = existingIndexes.some(i => i.name === indexDef.name);

      if (indexExists) {
        existing++;
        continue;
      }

      await collection.createIndex(indexDef.keys as any, {
        name: indexDef.name,
        background: true,
        ...indexDef.options,
      });
      
      created++;
      logger.info('Index created', { 
        collection: indexDef.collection, 
        name: indexDef.name,
      });
    } catch (error) {
      const msg = `Failed to create index ${indexDef.name} on ${indexDef.collection}: ${error}`;
      errors.push(msg);
      logger.error('Index creation failed', { 
        collection: indexDef.collection, 
        name: indexDef.name, 
        error: String(error),
      });
    }
  }

  logger.info('Index initialization complete', { created, existing, errors: errors.length });
  return { created, existing, errors };
}

export async function listIndexes(collectionName: string): Promise<any[]> {
  const db = await getDb();
  return db.collection(collectionName).indexes();
}

export async function dropIndex(collectionName: string, indexName: string): Promise<boolean> {
  try {
    const db = await getDb();
    await db.collection(collectionName).dropIndex(indexName);
    logger.info('Index dropped', { collection: collectionName, name: indexName });
    return true;
  } catch (error) {
    logger.error('Failed to drop index', { 
      collection: collectionName, 
      name: indexName, 
      error: String(error),
    });
    return false;
  }
}

export { indexes };
