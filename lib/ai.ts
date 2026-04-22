// lib/ai.ts
import OpenAI from "openai";
import { trackApiRequest } from "@/lib/api-usage-tracker";

// Available OpenAI models via Replit AI Integrations
export const MODELS = [
  "gpt-4o-mini",
  "gpt-4o",
  "gpt-4.1-mini",
  "gpt-4.1",
  "o3-mini",
] as const;

export const DEFAULT_MODEL = "gpt-4o-mini";

// Get the OpenAI configuration from available sources
// Priority: 1) OPENAI_API_KEY (self-hosted), 2) AI_INTEGRATIONS_OPENAI_API_KEY (Replit integration)
export function getOpenAIConfig(): { apiKey: string; baseUrl: string; source: 'direct' | 'replit' } | null {
  if (typeof window !== 'undefined') return null;
  
  try {
    const env = (globalThis as any).process?.env;
    
    // Check for direct API key first (self-hosted)
    if (env?.OPENAI_API_KEY) {
      return { 
        apiKey: env.OPENAI_API_KEY, 
        baseUrl: 'https://api.openai.com/v1',
        source: 'direct' 
      };
    }
    
    // Fall back to Replit's AI integration
    if (env?.AI_INTEGRATIONS_OPENAI_API_KEY) {
      return { 
        apiKey: env.AI_INTEGRATIONS_OPENAI_API_KEY, 
        baseUrl: env.AI_INTEGRATIONS_OPENAI_BASE_URL || 'https://api.openai.com/v1',
        source: 'replit' 
      };
    }
    
    return null;
  } catch {
    return null;
  }
}

// Legacy function for backwards compatibility
export function getOpenAIKey(): { apiKey: string; source: 'direct' | 'replit' } | null {
  const config = getOpenAIConfig();
  if (!config) return null;
  return { apiKey: config.apiKey, source: config.source };
}

// OpenAI SDK client - returns the official OpenAI SDK instance
export function getOpenAI(): OpenAI {
  const config = getOpenAIConfig();
  
  if (!config) {
    throw new Error("No OpenAI API key configured. Set OPENAI_API_KEY or use Replit's AI integration.");
  }
  
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
  });
}

export async function runResponse(model: string, input: string): Promise<{
  ok: boolean;
  text?: string;
  error?: string;
  source?: 'direct' | 'replit';
}> {
  const config = getOpenAIConfig();
  
  if (!config) {
    return { ok: false, error: "No OpenAI API key configured. Set OPENAI_API_KEY or use Replit's AI integration." };
  }
  
  const { apiKey, baseUrl, source } = config;

  try {
    const resp = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, input }),
    });

    if (!resp.ok) {
      const err = await safeText(resp);
      return { ok: false, error: `OpenAI ${resp.status}: ${err}` };
    }

    const data: any = await resp.json();
    const text = data?.output_text ?? extractTextFromResponse(data);
    return { ok: true, text: typeof text === "string" ? text : JSON.stringify(data), source };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "OpenAI request failed", source };
  }
}

function extractTextFromResponse(data: any): string {
  const parts =
    data?.output?.[0]?.content ??
    data?.choices?.[0]?.message?.content ??
    [];
  if (Array.isArray(parts)) {
    return parts
      .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
      .join("")
      .trim();
  }
  return "";
}

async function safeText(resp: Response) {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}

interface OpenAiUsageShape {
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
}

/**
 * DRY helper for AI route handlers. Records token usage from a completed
 * OpenAI chat/completions response into the shared api_usage telemetry so
 * `enforceAiBudget` and the platform observability page can see it.
 *
 * Always pass a stable `route` string (e.g. "/api/extension/concern-assistant")
 * so per-route token spend is queryable. Safe to call with undefined shopId.
 */
export function trackOpenAiCall(
  shopId: number | null | undefined,
  route: string,
  completion: OpenAiUsageShape | null | undefined,
  latencyMs: number,
  statusCode: number = 200
): void {
  const usage = completion?.usage;
  if (!usage) return;
  trackApiRequest(
    "openai",
    route,
    "POST",
    statusCode,
    latencyMs,
    shopId ?? undefined,
    {
      tokens: {
        prompt: usage.prompt_tokens ?? 0,
        completion: usage.completion_tokens ?? 0,
        total: usage.total_tokens ?? 0,
      },
    }
  );
}
