import { trackApiRequest } from './api-usage-tracker';

export interface RenderLogEntry {
  id: string;
  timestamp: string;
  level: string;
  message: string;
  instanceId?: string;
  serviceId?: string;
  serviceName?: string;
}

export interface RenderLogsResponse {
  logs: RenderLogEntry[];
  hasMore: boolean;
  nextStartTime?: string;
  nextEndTime?: string;
}

export interface RenderService {
  id: string;
  name: string;
  type: string;
  suspended: string;
  createdAt: string;
  updatedAt: string;
  dashboardUrl: string;
  repo?: string;
  branch?: string;
  ownerId?: string;
}

export interface RenderEnvironment {
  name: string;
  apiKey: string;
  serviceIds: string[];
  ownerId?: string;
}

const RENDER_API_BASE = 'https://api.render.com/v1';

async function makeRenderRequest<T>(
  endpoint: string,
  apiKey: string,
  params?: Record<string, string>,
  environment: string = 'unknown'
): Promise<T> {
  const startTime = Date.now();
  const url = new URL(`${RENDER_API_BASE}${endpoint}`);
  
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value) url.searchParams.set(key, value);
    });
  }

  try {
    const response = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
    });

    const latencyMs = Date.now() - startTime;

    await trackApiRequest(
      'render',
      endpoint,
      'GET',
      response.status,
      latencyMs,
      0,
      { sourceWorker: environment }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Render API error: ${response.status} - ${errorText}`);
    }

    return response.json();
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    
    await trackApiRequest(
      'render',
      endpoint,
      'GET',
      500,
      latencyMs,
      0,
      { 
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        sourceWorker: environment 
      }
    );

    throw error;
  }
}

export async function fetchRenderLogs(
  apiKey: string,
  options: {
    serviceIds?: string[];
    ownerId?: string;
    startTime: string;
    endTime: string;
    level?: string;
    text?: string;
    limit?: number;
    environment?: string;
  }
): Promise<RenderLogsResponse> {
  const url = new URL(`${RENDER_API_BASE}/logs`);
  
  url.searchParams.set('startTime', options.startTime);
  url.searchParams.set('endTime', options.endTime);
  url.searchParams.set('direction', 'backward');
  
  if (options.ownerId) {
    url.searchParams.set('ownerId', options.ownerId);
  }
  if (options.serviceIds?.length) {
    options.serviceIds.forEach(id => url.searchParams.append('resource', id));
  }
  if (options.level) {
    url.searchParams.append('level', options.level);
  }
  if (options.text) {
    url.searchParams.append('text', options.text);
  }
  if (options.limit) {
    url.searchParams.set('limit', options.limit.toString());
  }

  const startTime = Date.now();
  
  try {
    const response = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
    });

    const latencyMs = Date.now() - startTime;

    await trackApiRequest(
      'render',
      '/logs',
      'GET',
      response.status,
      latencyMs,
      0,
      { sourceWorker: options.environment }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Render API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    
    const logs: RenderLogEntry[] = (data.logs || []).map((log: any) => {
      const labels = log.labels || [];
      const getLabel = (name: string) => labels.find((l: any) => l.name === name)?.value;
      
      return {
        id: log.id,
        timestamp: log.timestamp,
        level: getLabel('level') || 'info',
        message: log.message,
        instanceId: getLabel('instance'),
        serviceId: getLabel('resource'),
      };
    });

    return {
      logs,
      hasMore: data.hasMore || false,
      nextStartTime: data.nextStartTime,
      nextEndTime: data.nextEndTime,
    };
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    
    await trackApiRequest(
      'render',
      '/logs',
      'GET',
      500,
      latencyMs,
      0,
      { 
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        sourceWorker: options.environment 
      }
    );

    throw error;
  }
}

export async function fetchRenderServices(
  apiKey: string,
  environment: string = 'unknown'
): Promise<RenderService[]> {
  const response = await makeRenderRequest<Array<{
    service: {
      id: string;
      name: string;
      type: string;
      suspended: string;
      createdAt: string;
      updatedAt: string;
      dashboardUrl: string;
      repo?: string;
      branch?: string;
      ownerId?: string;
    };
    cursor: string;
  }>>('/services?limit=100', apiKey, undefined, environment);

  return response.map(item => ({
    id: item.service.id,
    name: item.service.name,
    type: item.service.type,
    suspended: item.service.suspended,
    createdAt: item.service.createdAt,
    updatedAt: item.service.updatedAt,
    dashboardUrl: item.service.dashboardUrl,
    repo: item.service.repo,
    branch: item.service.branch,
    ownerId: item.service.ownerId,
  }));
}

export async function fetchRenderDeploys(
  apiKey: string,
  serviceId: string,
  limit: number = 10,
  environment: string = 'unknown'
): Promise<Array<{
  id: string;
  commit: { id: string; message: string; createdAt: string };
  status: string;
  createdAt: string;
  finishedAt?: string;
}>> {
  const response = await makeRenderRequest<Array<{
    deploy: {
      id: string;
      commit: { id: string; message: string; createdAt: string };
      status: string;
      createdAt: string;
      finishedAt?: string;
    };
    cursor: string;
  }>>(`/services/${serviceId}/deploys?limit=${limit}`, apiKey, undefined, environment);

  return response.map(item => ({
    id: item.deploy.id,
    commit: item.deploy.commit,
    status: item.deploy.status,
    createdAt: item.deploy.createdAt,
    finishedAt: item.deploy.finishedAt,
  }));
}

export function getRenderEnvironments(): RenderEnvironment[] {
  const environments: RenderEnvironment[] = [];

  if (process.env.RENDER_API_KEY_PROD && process.env.RENDER_SERVICE_IDS_PROD) {
    environments.push({
      name: 'Production',
      apiKey: process.env.RENDER_API_KEY_PROD,
      serviceIds: process.env.RENDER_SERVICE_IDS_PROD.split(',').map(s => s.trim()),
      ownerId: process.env.RENDER_OWNER_ID_PROD,
    });
  }

  if (process.env.RENDER_API_KEY_QA && process.env.RENDER_SERVICE_IDS_QA) {
    environments.push({
      name: 'QA',
      apiKey: process.env.RENDER_API_KEY_QA,
      serviceIds: process.env.RENDER_SERVICE_IDS_QA.split(',').map(s => s.trim()),
      ownerId: process.env.RENDER_OWNER_ID_QA,
    });
  }

  if (process.env.RENDER_API_KEY && process.env.RENDER_SERVICE_IDS) {
    environments.push({
      name: 'Default',
      apiKey: process.env.RENDER_API_KEY,
      serviceIds: process.env.RENDER_SERVICE_IDS.split(',').map(s => s.trim()),
      ownerId: process.env.RENDER_OWNER_ID,
    });
  }

  return environments;
}
