import { NextResponse } from 'next/server';
import { getDb } from '@/lib/mongo';
import { getAllCacheStats } from '@/lib/cache';
import { createLogger } from '@/lib/logger';

const logger = createLogger('health');

interface HealthCheck {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  version: string;
  uptime: number;
  checks: {
    mongodb: ComponentHealth;
    cache: ComponentHealth;
    memory: ComponentHealth;
  };
}

interface ComponentHealth {
  status: 'up' | 'down' | 'degraded';
  latencyMs?: number;
  details?: Record<string, unknown>;
  error?: string;
}

async function checkMongoDB(): Promise<ComponentHealth> {
  const start = Date.now();
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    const latencyMs = Date.now() - start;
    
    const collections = await db.listCollections().toArray();
    
    return {
      status: latencyMs < 1000 ? 'up' : 'degraded',
      latencyMs,
      details: {
        collectionsCount: collections.length,
      },
    };
  } catch (error) {
    logger.error('MongoDB health check failed', { error: String(error) });
    return {
      status: 'down',
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

function checkCache(): ComponentHealth {
  try {
    const stats = getAllCacheStats();
    const totalHits = Object.values(stats).reduce((sum, s) => sum + s.hits, 0);
    const totalMisses = Object.values(stats).reduce((sum, s) => sum + s.misses, 0);
    const hitRate = totalHits + totalMisses > 0 
      ? (totalHits / (totalHits + totalMisses) * 100).toFixed(1) 
      : '0';

    return {
      status: 'up',
      details: {
        hitRate: `${hitRate}%`,
        totalHits,
        totalMisses,
        caches: Object.fromEntries(
          Object.entries(stats).map(([name, s]) => [
            name,
            { keys: s.keys, hits: s.hits, misses: s.misses },
          ])
        ),
      },
    };
  } catch (error) {
    return {
      status: 'down',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

function checkMemory(): ComponentHealth {
  const usage = process.memoryUsage();
  const heapUsedMB = Math.round(usage.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(usage.heapTotal / 1024 / 1024);
  const heapPercent = (usage.heapUsed / usage.heapTotal) * 100;

  return {
    status: heapPercent > 90 ? 'degraded' : 'up',
    details: {
      heapUsedMB,
      heapTotalMB,
      heapPercent: `${heapPercent.toFixed(1)}%`,
      rssMB: Math.round(usage.rss / 1024 / 1024),
      externalMB: Math.round(usage.external / 1024 / 1024),
    },
  };
}

export async function GET() {
  const startTime = Date.now();

  try {
    const [mongoHealth, cacheHealth, memoryHealth] = await Promise.all([
      checkMongoDB(),
      Promise.resolve(checkCache()),
      Promise.resolve(checkMemory()),
    ]);

    const allUp = [mongoHealth, cacheHealth, memoryHealth].every(c => c.status === 'up');
    const anyDown = [mongoHealth, cacheHealth, memoryHealth].some(c => c.status === 'down');

    const health: HealthCheck = {
      status: anyDown ? 'unhealthy' : (allUp ? 'healthy' : 'degraded'),
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version || '1.0.0',
      uptime: process.uptime(),
      checks: {
        mongodb: mongoHealth,
        cache: cacheHealth,
        memory: memoryHealth,
      },
    };

    const responseLatency = Date.now() - startTime;
    logger.info('Health check completed', { 
      status: health.status, 
      latencyMs: responseLatency,
    });

    return NextResponse.json(health, {
      status: health.status === 'unhealthy' ? 503 : 200,
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'X-Response-Time': `${responseLatency}ms`,
      },
    });
  } catch (error) {
    logger.error('Health check failed', { error: String(error) });
    return NextResponse.json(
      {
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: 'Health check failed',
      },
      { status: 503 }
    );
  }
}
