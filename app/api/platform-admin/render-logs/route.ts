import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { fetchRenderLogs, fetchRenderServices, fetchRenderDeploys, getRenderEnvironments, RenderLogEntry } from '@/lib/render-api';

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
  const action = searchParams.get('action') || 'logs';
  const environment = searchParams.get('environment');
  const hoursBack = parseInt(searchParams.get('hours') || '1');
  const level = searchParams.get('level') || undefined;
  const text = searchParams.get('text') || undefined;
  const serviceId = searchParams.get('serviceId') || undefined;

  const environments = getRenderEnvironments();

  if (environments.length === 0) {
    return NextResponse.json({
      error: 'No Render API keys configured',
      hint: 'Set RENDER_API_KEY_PROD and RENDER_SERVICE_IDS_PROD (or _QA) environment variables',
    }, { status: 400 });
  }

  try {
    if (action === 'environments') {
      return NextResponse.json({
        environments: environments.map(env => ({
          name: env.name,
          serviceCount: env.serviceIds.length,
        })),
      });
    }

    if (action === 'services') {
      const results: Array<{
        environment: string;
        services: Array<{
          id: string;
          name: string;
          type: string;
          suspended: string;
        }>;
      }> = [];

      for (const env of environments) {
        if (environment && env.name !== environment) continue;

        try {
          const services = await fetchRenderServices(env.apiKey, env.name);
          const filteredServices = env.serviceIds.length > 0
            ? services.filter(s => env.serviceIds.includes(s.id))
            : services;

          results.push({
            environment: env.name,
            services: filteredServices.map(s => ({
              id: s.id,
              name: s.name,
              type: s.type,
              suspended: s.suspended,
            })),
          });
        } catch (error) {
          console.error(`Error fetching services for ${env.name}:`, error);
          results.push({
            environment: env.name,
            services: [],
          });
        }
      }

      return NextResponse.json({ results });
    }

    if (action === 'deploys') {
      if (!serviceId) {
        return NextResponse.json({ error: 'serviceId required' }, { status: 400 });
      }

      const targetEnv = environments.find(e => 
        environment ? e.name === environment : e.serviceIds.includes(serviceId)
      );

      if (!targetEnv) {
        return NextResponse.json({ error: 'Service not found in any environment' }, { status: 404 });
      }

      const deploys = await fetchRenderDeploys(targetEnv.apiKey, serviceId, 20, targetEnv.name);
      return NextResponse.json({ deploys, environment: targetEnv.name });
    }

    const now = new Date();
    const startTime = new Date(now.getTime() - hoursBack * 60 * 60 * 1000).toISOString();
    const endTime = now.toISOString();

    const allLogs: Array<RenderLogEntry & { environment: string }> = [];
    const errors: Array<{ environment: string; error: string }> = [];

    for (const env of environments) {
      if (environment && env.name !== environment) continue;

      const serviceIds = serviceId ? [serviceId] : env.serviceIds;
      
      let ownerId = env.ownerId;
      if (!ownerId) {
        try {
          const services = await fetchRenderServices(env.apiKey, env.name);
          const targetService = services.find(s => serviceIds.includes(s.id));
          ownerId = targetService?.ownerId;
        } catch (e) {
          console.error(`Error fetching services for ownerId in ${env.name}:`, e);
        }
      }

      try {
        const logsResponse = await fetchRenderLogs(env.apiKey, {
          serviceIds,
          ownerId,
          startTime,
          endTime,
          level,
          text,
          limit: 100,
          environment: env.name,
        });

        for (const log of logsResponse.logs) {
          allLogs.push({
            ...log,
            environment: env.name,
          });
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        console.error(`Error fetching logs for ${env.name}:`, error);
        errors.push({ environment: env.name, error: errorMsg });
      }
    }

    allLogs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    const stats = {
      total: allLogs.length,
      byLevel: {
        error: allLogs.filter(l => l.level === 'error').length,
        warn: allLogs.filter(l => l.level === 'warn' || l.level === 'warning').length,
        info: allLogs.filter(l => l.level === 'info').length,
        debug: allLogs.filter(l => l.level === 'debug').length,
      },
      byEnvironment: environments.reduce((acc, env) => {
        acc[env.name] = allLogs.filter(l => l.environment === env.name).length;
        return acc;
      }, {} as Record<string, number>),
    };

    return NextResponse.json({
      logs: allLogs.slice(0, 500),
      stats,
      hasMore: allLogs.length > 500,
      timeRange: { startTime, endTime },
      errors: errors.length > 0 ? errors : undefined,
    });

  } catch (error) {
    console.error('Error in render-logs API:', error);
    return NextResponse.json({
      error: 'Failed to fetch Render data',
      message: error instanceof Error ? error.message : 'Unknown error',
    }, { status: 500 });
  }
}
