import { createLogger } from './logger';

const logger = createLogger('query-monitor');

const SLOW_QUERY_THRESHOLD_MS = 500;

interface QueryMetrics {
  collection: string;
  operation: string;
  duration: number;
  timestamp: Date;
}

const recentSlowQueries: QueryMetrics[] = [];
const MAX_SLOW_QUERIES = 100;

export function recordQueryMetrics(
  collection: string,
  operation: string,
  startTime: number
): void {
  const duration = Date.now() - startTime;
  
  if (duration > SLOW_QUERY_THRESHOLD_MS) {
    logger.warn('Slow query detected', {
      collection,
      operation,
      durationMs: duration,
    });
    
    recentSlowQueries.push({
      collection,
      operation,
      duration,
      timestamp: new Date(),
    });
    
    if (recentSlowQueries.length > MAX_SLOW_QUERIES) {
      recentSlowQueries.shift();
    }
  }
}

export function getSlowQueries(): QueryMetrics[] {
  return [...recentSlowQueries];
}

export function clearSlowQueries(): void {
  recentSlowQueries.length = 0;
}

export async function withQueryMonitoring<T>(
  collection: string,
  operation: string,
  fn: () => Promise<T>
): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    recordQueryMetrics(collection, operation, start);
  }
}

export function getQueryStats(): {
  totalSlowQueries: number;
  byCollection: Record<string, number>;
  byOperation: Record<string, number>;
  avgDuration: number;
} {
  const byCollection: Record<string, number> = {};
  const byOperation: Record<string, number> = {};
  let totalDuration = 0;
  
  for (const query of recentSlowQueries) {
    byCollection[query.collection] = (byCollection[query.collection] || 0) + 1;
    byOperation[query.operation] = (byOperation[query.operation] || 0) + 1;
    totalDuration += query.duration;
  }
  
  return {
    totalSlowQueries: recentSlowQueries.length,
    byCollection,
    byOperation,
    avgDuration: recentSlowQueries.length > 0 
      ? Math.round(totalDuration / recentSlowQueries.length) 
      : 0,
  };
}
