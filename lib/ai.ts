// lib/ai.ts

// Available OpenAI models
export const MODELS = [
  "gpt-4o-mini",
  "gpt-4o",
  "gpt-4",
  "gpt-4-turbo", 
  "gpt-3.5-turbo",
] as const;

export const DEFAULT_MODEL = "gpt-4o-mini";

// Get the OpenAI API key from available sources
// Priority: 1) OPENAI_API_KEY (self-hosted), 2) AI_INTEGRATIONS_OPENAI_API_KEY (Replit integration)
export function getOpenAIKey(): { apiKey: string; source: 'direct' | 'replit' } | null {
  if (typeof window !== 'undefined') return null;
  
  try {
    const env = (globalThis as any).process?.env;
    
    // Check for direct API key first (self-hosted)
    if (env?.OPENAI_API_KEY) {
      return { apiKey: env.OPENAI_API_KEY, source: 'direct' };
    }
    
    // Fall back to Replit's AI integration
    if (env?.AI_INTEGRATIONS_OPENAI_API_KEY) {
      return { apiKey: env.AI_INTEGRATIONS_OPENAI_API_KEY, source: 'replit' };
    }
    
    return null;
  } catch {
    return null;
  }
}

// OpenAI client wrapper
export function getOpenAI() {
  const keyInfo = getOpenAIKey();
  
  if (!keyInfo) {
    throw new Error("No OpenAI API key configured. Set OPENAI_API_KEY or use Replit's AI integration.");
  }
  
  const { apiKey } = keyInfo;
  
  return {
    apiKey,
    source: keyInfo.source,
    async chat(messages: any[], model = DEFAULT_MODEL) {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: 1000,
        }),
      });
      
      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.statusText}`);
      }
      
      return response.json();
    }
  };
}

export async function runResponse(model: string, input: string): Promise<{
  ok: boolean;
  text?: string;
  error?: string;
  source?: 'direct' | 'replit';
}> {
  const keyInfo = getOpenAIKey();
  
  if (!keyInfo) {
    return { ok: false, error: "No OpenAI API key configured. Set OPENAI_API_KEY or use Replit's AI integration." };
  }
  
  const { apiKey, source } = keyInfo;

  try {
    const resp = await fetch("https://api.openai.com/v1/responses", {
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
