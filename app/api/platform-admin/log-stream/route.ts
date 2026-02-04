import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/mongo';
import { getSession } from '@/lib/auth';
import { trackApiRequest } from '@/lib/api-usage-tracker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RenderLogStreamEntry {
  id?: string;
  timestamp: string;
  level: string;
  message: string;
  instanceId?: string;
  serviceId: string;
  serviceName?: string;
  deployId?: string;
}

interface RenderWebhookPayload {
  type: 'log' | 'logs';
  environment?: string;
  logs?: RenderLogStreamEntry[];
  log?: RenderLogStreamEntry;
}

const LOG_STREAM_SECRET = process.env.RENDER_LOG_STREAM_SECRET;

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  
  const authHeader = request.headers.get('authorization');
  const providedSecret = authHeader?.replace('Bearer ', '');
  
  if (!LOG_STREAM_SECRET) {
    console.warn('[LogStream] RENDER_LOG_STREAM_SECRET not configured');
    return NextResponse.json({ error: 'Log streaming not configured' }, { status: 503 });
  }
  
  if (providedSecret !== LOG_STREAM_SECRET) {
    return NextResponse.json({ error: 'Invalid authentication' }, { status: 401 });
  }

  try {
    const payload: RenderWebhookPayload = await request.json();
    const db = await getDb();
    const collection = db.collection('render_log_stream');
    
    const logs: RenderLogStreamEntry[] = [];
    
    if (payload.type === 'logs' && payload.logs) {
      logs.push(...payload.logs);
    } else if (payload.type === 'log' && payload.log) {
      logs.push(payload.log);
    }
    
    if (logs.length === 0) {
      return NextResponse.json({ ok: true, stored: 0 });
    }
    
    const environment = payload.environment || 'unknown';
    
    const documents = logs.map(log => ({
      logId: log.id || `${log.serviceId}-${log.timestamp}`,
      timestamp: new Date(log.timestamp),
      level: log.level?.toLowerCase() || 'info',
      message: log.message,
      serviceId: log.serviceId,
      serviceName: log.serviceName,
      instanceId: log.instanceId,
      deployId: log.deployId,
      environment,
      receivedAt: new Date(),
    }));
    
    await collection.insertMany(documents, { ordered: false }).catch(err => {
      if (err.code !== 11000) throw err;
    });
    
    const latencyMs = Date.now() - startTime;
    await trackApiRequest('render', '/log-stream', 'POST', 200, latencyMs, undefined, {
      sourceWorker: environment,
      requestId: `log-batch-${logs.length}`
    });
    
    return NextResponse.json({ ok: true, stored: logs.length });
    
  } catch (error) {
    console.error('[LogStream] Error processing logs:', error);
    const latencyMs = Date.now() - startTime;
    await trackApiRequest('render', '/log-stream', 'POST', 500, latencyMs, undefined, {
      errorMessage: error instanceof Error ? error.message : 'Unknown error'
    });
    return NextResponse.json({ 
      error: 'Failed to process logs',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!session.isPlatformAdmin) {
    return NextResponse.json({ error: 'Forbidden - platform admin access required' }, { status: 403 });
  }

  const searchParams = request.nextUrl.searchParams;
  const hoursBack = parseInt(searchParams.get('hours') || '1');
  const level = searchParams.get('level') || undefined;
  const serviceId = searchParams.get('serviceId') || undefined;
  const environment = searchParams.get('environment') || undefined;
  const text = searchParams.get('text') || undefined;
  const limit = Math.min(parseInt(searchParams.get('limit') || '500'), 2000);

  try {
    const db = await getDb();
    const collection = db.collection('render_log_stream');
    
    const now = new Date();
    const startTime = new Date(now.getTime() - hoursBack * 60 * 60 * 1000);
    
    const query: Record<string, any> = {
      timestamp: { $gte: startTime, $lte: now }
    };
    
    if (level) query.level = level.toLowerCase();
    if (serviceId) query.serviceId = serviceId;
    if (environment) query.environment = environment;
    if (text) query.message = { $regex: text, $options: 'i' };
    
    const logs = await collection
      .find(query)
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();
    
    const stats = await collection.aggregate([
      { $match: query },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          error: { $sum: { $cond: [{ $eq: ['$level', 'error'] }, 1, 0] } },
          warn: { $sum: { $cond: [{ $in: ['$level', ['warn', 'warning']] }, 1, 0] } },
          info: { $sum: { $cond: [{ $eq: ['$level', 'info'] }, 1, 0] } },
          debug: { $sum: { $cond: [{ $eq: ['$level', 'debug'] }, 1, 0] } },
        }
      }
    ]).toArray();
    
    const statsSummary = stats[0] || { total: 0, error: 0, warn: 0, info: 0, debug: 0 };
    
    const environments = await collection.distinct('environment', { 
      timestamp: { $gte: startTime, $lte: now } 
    });
    
    const services = await collection.aggregate([
      { $match: { timestamp: { $gte: startTime, $lte: now } } },
      { $group: { _id: { serviceId: '$serviceId', serviceName: '$serviceName' } } }
    ]).toArray();
    
    return NextResponse.json({
      logs,
      stats: {
        total: statsSummary.total,
        byLevel: {
          error: statsSummary.error,
          warn: statsSummary.warn,
          info: statsSummary.info,
          debug: statsSummary.debug,
        }
      },
      environments,
      services: services.map(s => s._id),
      hasMore: logs.length === limit,
      timeRange: { 
        startTime: startTime.toISOString(), 
        endTime: now.toISOString() 
      },
    });
    
  } catch (error) {
    console.error('[LogStream] Error fetching logs:', error);
    return NextResponse.json({
      error: 'Failed to fetch logs',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}
