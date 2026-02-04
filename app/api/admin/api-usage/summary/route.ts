import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getDb } from '@/lib/mongo';
import { API_PROVIDER_CONFIGS, ApiProvider } from '@/lib/api-usage-tracker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!session.isPlatformAdmin) {
    return NextResponse.json({ error: 'Forbidden - platform admin access required' }, { status: 403 });
  }

  const searchParams = request.nextUrl.searchParams;
  const hoursBack = parseInt(searchParams.get('hours') || '24');
  const provider = searchParams.get('provider') as ApiProvider | null;

  try {
    const db = await getDb();
    const collection = db.collection('api_usage');
    
    const now = new Date();
    const startTime = new Date(now.getTime() - hoursBack * 60 * 60 * 1000);

    const matchStage: Record<string, any> = {
      timestamp: { $gte: startTime, $lte: now }
    };
    if (provider) {
      matchStage.provider = provider;
    }

    const results = await collection.aggregate([
      { $match: matchStage },
      {
        $group: {
          _id: { provider: '$provider', endpoint: '$endpoint' },
          count: { $sum: 1 },
          errors: { $sum: { $cond: ['$isError', 1, 0] } },
          totalLatency: { $sum: '$latencyMs' },
        }
      },
      {
        $group: {
          _id: '$_id.provider',
          total: { $sum: '$count' },
          errors: { $sum: '$errors' },
          totalLatency: { $sum: '$totalLatency' },
          endpoints: {
            $push: {
              endpoint: '$_id.endpoint',
              count: '$count',
              errors: '$errors'
            }
          }
        }
      },
      { $sort: { total: -1 } }
    ]).toArray();

    const providers = results.map(r => ({
      provider: API_PROVIDER_CONFIGS[r._id as ApiProvider]?.name || r._id,
      providerId: r._id,
      total: r.total,
      errors: r.errors,
      avgLatency: r.total > 0 ? r.totalLatency / r.total : 0,
      endpoints: r.endpoints
        .sort((a: any, b: any) => b.count - a.count)
        .slice(0, 10)
    }));

    return NextResponse.json({
      providers,
      timeRange: {
        startTime: startTime.toISOString(),
        endTime: now.toISOString(),
        hoursBack
      }
    });

  } catch (error) {
    console.error('[ApiUsage] Error fetching summary:', error);
    return NextResponse.json({
      error: 'Failed to fetch API usage',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}
