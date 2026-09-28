import { testConnection } from "@/lib/integrations/protractor";
import { runWithProtractorInteractiveTransport } from "@/lib/integrations/protractor/interactive-context";

// Call only after authentication and server-side shop resolution. No saving,
// webhook work, or backfill may inherit this capability.
export async function validateCredentials(shopId: number, connectionId: string, apiKey: string) {
  try {
    return await runWithProtractorInteractiveTransport(shopId, () =>
      testConnection(connectionId, apiKey, shopId),
    );
  } catch {
    return { ok: false, code: "PROTRACTOR_VALIDATION_UNAVAILABLE" };
  }
}

export function validationFailure(result: { error?: string; code?: string }) {
  const unavailable = result.code !== "PROTRACTOR_INVALID_CREDENTIALS";
  return {
    status: unavailable ? 503 : 400,
    body: {
      ok: false,
      code: unavailable ? "PROTRACTOR_VALIDATION_UNAVAILABLE" : "PROTRACTOR_INVALID_CREDENTIALS",
      error: unavailable
        ? "Protractor credential validation is restricted or unavailable. Please try again later."
        : "Protractor rejected these credentials.",
    },
  };
}