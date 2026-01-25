import crypto from "node:crypto";
import https from "node:https";
import pLimit from "p-limit";
import { getDb } from "@/lib/mongo";
import { trackApiRequest } from "@/lib/api-usage-tracker";
import { acquireRateLimitSlot } from "@/lib/integrations/core/rate-limiter";
import type { ProtractorConfig } from "./types";

const BASE_URL = "https://integration.protractor.com/IntegrationServices/2.0";

const protractorConcurrencyLimit = pLimit(3);

export function computeAuthentication(connectionId: string, apiKey: string): string {
  const keyBytes = Buffer.from(apiKey.replace(/-/g, "").toLowerCase(), "utf8");
  const dataBytes = Buffer.from(connectionId.replace(/-/g, "").toLowerCase(), "utf8");
  
  const hmac = crypto.createHmac("sha1", keyBytes);
  hmac.update(dataBytes);
  
  return hmac.digest("base64");
}

export async function resolveProtractorConfig(shopId: number | string): Promise<ProtractorConfig> {
  const db = await getDb();
  const shop = await db.collection("shops").findOne(
    { $or: [{ shopId: String(shopId) }, { shopId: Number(shopId) }] },
    {
      projection: {
        protractor: 1,
        protractorConnectionId: 1,
        protractorApiKey: 1,
      },
    }
  );

  const connectionId =
    shop?.protractorConnectionId ??
    shop?.protractor?.connectionId ??
    process.env.PROTRACTOR_CONNECTION_ID ??
    "";

  const apiKey =
    shop?.protractorApiKey ??
    shop?.protractor?.apiKey ??
    process.env.PROTRACTOR_API_KEY ??
    "";

  const configured = Boolean(connectionId && apiKey);
  const authentication = configured ? computeAuthentication(connectionId, apiKey) : "";

  return {
    connectionId,
    apiKey,
    authentication,
    configured,
  };
}

function httpsRequest(
  urlString: string,
  method: string,
  headers: Record<string, string>,
  body?: string
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    
    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: method,
      headers: headers,
    };
    
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        resolve({ statusCode: res.statusCode || 0, body: data });
      });
    });
    
    req.on("error", (err) => {
      reject(err);
    });
    
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });
    
    if (body) {
      req.write(body);
    }
    
    req.end();
  });
}

export async function protractorFetch<T>(
  endpoint: string,
  config: ProtractorConfig,
  options: RequestInit = {},
  retryCount = 0,
  shopId?: number
): Promise<{ ok: boolean; data?: T; error?: string }> {
  if (!config.configured) {
    return { ok: false, error: "Protractor not configured" };
  }

  return protractorConcurrencyLimit(async () => {
    const rateSlot = await acquireRateLimitSlot('protractor', 5);
    if (!rateSlot.acquired) {
      return { ok: false, error: "Rate limit exceeded or circuit breaker open" };
    }

    const url = `${BASE_URL}${endpoint}`;
    const startTime = Date.now();
    const method = (options.method || "GET").toUpperCase();
  
    try {
      const headers: Record<string, string> = {
        "connectionid": config.connectionId,
        "apikey": config.apiKey,
        "authentication": config.authentication,
        "Accept": "application/json",
        "Content-Type": "application/json",
      };
      
      if (options.headers) {
        const optHeaders = options.headers as Record<string, string>;
        Object.entries(optHeaders).forEach(([key, value]) => {
          headers[key] = value;
        });
      }
      
      const body = options.body ? String(options.body) : undefined;
      const res = await httpsRequest(url, method, headers, body);

      const latencyMs = Date.now() - startTime;
      const isServerError = res.statusCode >= 500;
      const isRateLimited = res.statusCode === 429;
      
      trackApiRequest('protractor', endpoint, method, res.statusCode, latencyMs, shopId, {
        retryCount: retryCount > 0 ? retryCount : undefined,
        errorMessage: res.statusCode >= 400 ? res.body?.substring(0, 200) : undefined,
        sourceWorker: process.env.RENDER ? 'render' : 'replit'
      }).catch(() => {});

      if ((isRateLimited || isServerError) && retryCount < 3) {
        const baseWaitMs = Math.pow(2, retryCount + 1) * 1000;
        const jitter = Math.random() * 500;
        const waitMs = baseWaitMs + jitter;
        
        console.log(`[Protractor] ${isRateLimited ? 'Rate limited' : `Server error ${res.statusCode}`}, retrying in ${Math.round(waitMs)}ms (attempt ${retryCount + 1}/3)`);
        await new Promise(r => setTimeout(r, waitMs));
        return protractorFetch<T>(endpoint, config, options, retryCount + 1, shopId);
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        return { ok: false, error: `HTTP ${res.statusCode}: ${res.body || "Unknown error"}` };
      }

      const data = res.body ? JSON.parse(res.body) : null;
      return { ok: true, data: data as T };
    } catch (err: any) {
      return { ok: false, error: err.message || "Network error" };
    }
  });
}

export async function testConnection(shopId: number): Promise<{ ok: boolean; error?: string }> {
  const config = await resolveProtractorConfig(shopId);
  if (!config.configured) {
    return { ok: false, error: "Protractor credentials not configured" };
  }

  const result = await protractorFetch<{ ItemCollection?: unknown[] }>(
    "/ServiceItem/?take=1",
    config,
    {},
    0,
    shopId
  );

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  return { ok: true };
}
