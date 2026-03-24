import { getDb } from "@/lib/db/drizzle";
import { apiUsageLogs } from "@/lib/db/schema";

const DEEPGRAM_STT_COST_PER_MIN = 0.0059;
const DEEPGRAM_TTS_COST_PER_CHAR = 0.000015;
const OPENAI_GPT4O_INPUT_PER_TOKEN = 0.0000025;
const OPENAI_GPT4O_OUTPUT_PER_TOKEN = 0.00001;

export function estimateDeepgramCost(
  durationSeconds: number,
  ttsCharacters: number,
): number {
  const sttCost = (durationSeconds / 60) * DEEPGRAM_STT_COST_PER_MIN;
  const ttsCost = ttsCharacters * DEEPGRAM_TTS_COST_PER_CHAR;
  return sttCost + ttsCost;
}

export function estimateOpenAICost(
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    inputTokens * OPENAI_GPT4O_INPUT_PER_TOKEN +
    outputTokens * OPENAI_GPT4O_OUTPUT_PER_TOKEN
  );
}

export function estimateTotalCallCost(params: {
  durationSeconds: number;
  ttsCharacters: number;
  inputTokens: number;
  outputTokens: number;
}): number {
  return (
    estimateDeepgramCost(params.durationSeconds, params.ttsCharacters) +
    estimateOpenAICost(params.inputTokens, params.outputTokens)
  );
}

export async function logApiUsage(params: {
  shopId: number;
  service: string;
  endpoint?: string;
  method?: string;
  tokensInput?: number;
  tokensOutput?: number;
  totalTokens?: number;
  costEstimate?: number;
  latencyMs?: number;
  statusCode?: number;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    const db = getDb();
    await db.insert(apiUsageLogs).values({
      shopId: params.shopId,
      service: params.service,
      endpoint: params.endpoint ?? null,
      method: params.method ?? null,
      tokensInput: params.tokensInput ?? null,
      tokensOutput: params.tokensOutput ?? null,
      totalTokens: params.totalTokens ?? null,
      costEstimate: params.costEstimate ?? null,
      latencyMs: params.latencyMs ?? null,
      statusCode: params.statusCode ?? null,
      errorMessage: params.errorMessage ?? null,
      metadata: params.metadata ?? null,
    });
  } catch (err) {
    console.error("[RescueRover] Failed to log API usage:", err);
  }
}
