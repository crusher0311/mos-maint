/** Server-owned policy; never accept arbitrary caller-selected models. */
export const ANALYZER_MODELS = ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini"] as const;
export function analyzerModel(value: unknown, fallback = "gpt-4.1"): string | null {
  if (value === undefined || value === null || value === "") return fallback;
  return typeof value === "string" && ANALYZER_MODELS.includes(value as any) ? value : null;
}
export const MODEL_POLICY_ERROR = "Unsupported AI model. Choose an approved model.";
