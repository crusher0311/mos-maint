import { getDb } from './mongo';
import { createLogger } from './logger';
import { AnyBulkWriteOperation, Document } from 'mongodb';

const logger = createLogger('batch-ops');

const BATCH_SIZE = 100;

export interface BulkUpsertItem<T> {
  filter: Record<string, unknown>;
  update: Record<string, unknown>;
  setOnInsert?: Record<string, unknown>;
}

export async function bulkUpsert<T extends Document>(
  collectionName: string,
  items: BulkUpsertItem<T>[]
): Promise<{ matched: number; modified: number; upserted: number }> {
  if (items.length === 0) {
    return { matched: 0, modified: 0, upserted: 0 };
  }

  const db = await getDb();
  const collection = db.collection(collectionName);
  
  let totalMatched = 0;
  let totalModified = 0;
  let totalUpserted = 0;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    
    const operations: AnyBulkWriteOperation<Document>[] = batch.map(item => ({
      updateOne: {
        filter: item.filter,
        update: {
          $set: item.update,
          ...(item.setOnInsert ? { $setOnInsert: item.setOnInsert } : {}),
        },
        upsert: true,
      },
    }));

    try {
      const result = await collection.bulkWrite(operations, { ordered: false });
      totalMatched += result.matchedCount;
      totalModified += result.modifiedCount;
      totalUpserted += result.upsertedCount;
    } catch (error: any) {
      logger.error('Bulk upsert batch failed', {
        collection: collectionName,
        batchIndex: Math.floor(i / BATCH_SIZE),
        error: error.message,
      });
      throw error;
    }
  }

  logger.info('Bulk upsert completed', {
    collection: collectionName,
    items: items.length,
    matched: totalMatched,
    modified: totalModified,
    upserted: totalUpserted,
  });

  return { matched: totalMatched, modified: totalModified, upserted: totalUpserted };
}

export async function bulkFindByIds<T extends Document>(
  collectionName: string,
  idField: string,
  ids: (string | number)[],
  projection?: Record<string, 1 | 0>
): Promise<Map<string | number, T>> {
  if (ids.length === 0) {
    return new Map();
  }

  const db = await getDb();
  const collection = db.collection<T>(collectionName);
  
  const uniqueIds = [...new Set(ids)];
  const results = new Map<string | number, T>();

  for (let i = 0; i < uniqueIds.length; i += BATCH_SIZE) {
    const batch = uniqueIds.slice(i, i + BATCH_SIZE);
    
    const cursor = collection.find(
      { [idField]: { $in: batch } } as any,
      projection ? { projection } : undefined
    );
    
    const docs = await cursor.toArray();
    for (const doc of docs) {
      const key = (doc as any)[idField];
      results.set(key, doc as T);
    }
  }

  logger.debug('Bulk find completed', {
    collection: collectionName,
    requested: ids.length,
    found: results.size,
  });

  return results;
}

export async function batchProcess<T, R>(
  items: T[],
  processor: (batch: T[]) => Promise<R[]>,
  batchSize: number = BATCH_SIZE
): Promise<R[]> {
  const results: R[] = [];
  
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await processor(batch);
    results.push(...batchResults);
  }
  
  return results;
}

export async function parallelBatchProcess<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  concurrency: number = 5
): Promise<R[]> {
  const results: R[] = [];
  
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(processor));
    results.push(...batchResults);
  }
  
  return results;
}
