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

    // Today (UTC) bucket for OpenAI token-spend reporting.
    const utcDayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    const [results, openAiTokensTodayAgg] = await Promise.all([
      collection.aggregate([
        { $match: matchStage },
        {
          $group: {
            _id: { provider: '$provider', endpoint: '$endpoint' },
            count: { $sum: 1 },
            errors: { $sum: { $cond: ['$isError', 1, 0] } },
            totalLatency: { $sum: '$latencyMs' },
            tokens: { $sum: { $ifNull: ['$totalTokens', 0] } },
          }
        },
        {
          $group: {
            _id: '$_id.provider',
            total: { $sum: '$count' },
            errors: { $sum: '$errors' },
            totalLatency: { $sum: '$totalLatency' },
            tokensInWindow: { $sum: '$tokens' },
            driftCount: {
              $sum: {
                $cond: [{ $eq: ['$_id.endpoint', '/verify/drift'] }, '$count', 0]
              }
            },
            verifyOkCount: {
              $sum: {
                $cond: [{ $eq: ['$_id.endpoint', '/verify/ok'] }, '$count', 0]
              }
            },
            endpoints: {
              $push: {
                endpoint: '$_id.endpoint',
                count: '$count',
                errors: '$errors',
                tokens: '$tokens',
              }
            }
          }
        },
        { $sort: { total: -1 } }
      ]).toArray(),
      collection.aggregate([
        { $match: { provider: 'openai', timestamp: { $gte: utcDayStart, $lte: now } } },
        { $group: { _id: '$shopId', tokens: { $sum: { $ifNull: ['$totalTokens', 0] } } } },
        { $sort: { tokens: -1 } },
        { $limit: 10 },
      ]).toArray(),
    ]);

    const providers = results.map(r => ({
      provider: API_PROVIDER_CONFIGS[r._id as ApiProvider]?.name || r._id,
      providerId: r._id,
      total: r.total,
      errors: r.errors,
      driftCount: r.driftCount || 0,
      verifyOkCount: r.verifyOkCount || 0,
      tokensInWindow: r.tokensInWindow || 0,
      avgLatency: r.total > 0 ? r.totalLatency / r.total : 0,
      endpoints: r.endpoints
        .sort((a: any, b: any) => b.count - a.count)
        .slice(0, 10)
    }));

    const openAiTokensToday = openAiTokensTodayAgg.reduce((sum: number, r: any) => sum + (r.tokens || 0), 0);
    const topShopsByTokensToday = openAiTokensTodayAgg.map((r: any) => ({
      shopId: r._id ?? null,
      tokens: r.tokens || 0,
    }));

    return NextResponse.json({
      providers,
      openAi: {
        tokensToday: openAiTokensToday,
        topShopsByTokensToday,
        utcDayStart: utcDayStart.toISOString(),
      },
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
