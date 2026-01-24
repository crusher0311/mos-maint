import { NextRequest, NextResponse } from "next/server";
import { 
  validateApiKey, 
  checkPermission, 
  checkRateLimit, 
  logApiUsage,
  updateApiKeyUsage,
  ApiKey 
} from "./api-keys";

export interface ExternalApiContext {
  apiKey: ApiKey;
  shopId: number;
}

export type ExternalApiHandler = (
  req: NextRequest,
  context: ExternalApiContext
) => Promise<NextResponse>;

export function withExternalAuth(
  handler: ExternalApiHandler,
  requiredPermission: string
) {
  return async (req: NextRequest): Promise<NextResponse> => {
    const startTime = Date.now();
    let statusCode = 200;
    let apiKey: ApiKey | undefined;
    
    try {
      const authHeader = req.headers.get("authorization");
      const apiKeyHeader = req.headers.get("x-api-key");
      
      let rawKey: string | null = null;
      
      if (authHeader?.startsWith("Bearer ")) {
        rawKey = authHeader.substring(7);
      } else if (apiKeyHeader) {
        rawKey = apiKeyHeader;
      }
      
      if (!rawKey) {
        statusCode = 401;
        return NextResponse.json(
          { 
            error: "Authentication required",
            message: "Provide API key via Authorization: Bearer <key> or X-API-Key header"
          },
          { status: 401 }
        );
      }
      
      const validation = await validateApiKey(rawKey);
      
      if (!validation.valid || !validation.apiKey) {
        statusCode = 401;
        return NextResponse.json(
          { error: "Invalid API key", message: validation.error },
          { status: 401 }
        );
      }
      
      apiKey = validation.apiKey;
      
      const hasPermission = await checkPermission(apiKey, requiredPermission);
      if (!hasPermission) {
        statusCode = 403;
        return NextResponse.json(
          { 
            error: "Permission denied",
            message: `This API key does not have the '${requiredPermission}' permission`
          },
          { status: 403 }
        );
      }
      
      const rateLimitCheck = await checkRateLimit(apiKey.keyHash, apiKey.rateLimit);
      if (!rateLimitCheck.allowed) {
        statusCode = 429;
        return NextResponse.json(
          { 
            error: "Rate limit exceeded",
            message: `Rate limit of ${apiKey.rateLimit} requests per minute exceeded`,
            retryAfter: Math.ceil((rateLimitCheck.resetAt.getTime() - Date.now()) / 1000)
          },
          { 
            status: 429,
            headers: {
              "X-RateLimit-Limit": String(apiKey.rateLimit),
              "X-RateLimit-Remaining": "0",
              "X-RateLimit-Reset": rateLimitCheck.resetAt.toISOString(),
              "Retry-After": String(Math.ceil((rateLimitCheck.resetAt.getTime() - Date.now()) / 1000))
            }
          }
        );
      }
      
      const context: ExternalApiContext = {
        apiKey,
        shopId: apiKey.shopId,
      };
      
      const response = await handler(req, context);
      statusCode = response.status;
      
      const enrichedResponse = new NextResponse(response.body, {
        status: response.status,
        headers: {
          ...Object.fromEntries(response.headers.entries()),
          "X-RateLimit-Limit": String(apiKey.rateLimit),
          "X-RateLimit-Remaining": String(rateLimitCheck.remaining - 1),
          "X-RateLimit-Reset": rateLimitCheck.resetAt.toISOString(),
        }
      });
      
      return enrichedResponse;
      
    } catch (err: any) {
      console.error("[External API] Error:", err);
      statusCode = 500;
      return NextResponse.json(
        { error: "Internal server error", message: err.message },
        { status: 500 }
      );
    } finally {
      if (apiKey) {
        const responseTime = Date.now() - startTime;
        
        if (statusCode >= 200 && statusCode < 300) {
          await updateApiKeyUsage(apiKey.keyHash)
            .catch(err => console.error("[External API] Failed to update usage:", err));
        }
        
        await logApiUsage({
          keyHash: apiKey.keyHash,
          shopId: apiKey.shopId,
          endpoint: req.nextUrl.pathname,
          method: req.method,
          statusCode,
          responseTime,
          timestamp: new Date(),
          ip: req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || undefined,
        }).catch(err => console.error("[External API] Failed to log usage:", err));
      }
    }
  };
}

export function createExternalEndpoint(
  permission: string,
  handler: ExternalApiHandler
) {
  return withExternalAuth(handler, permission);
}
