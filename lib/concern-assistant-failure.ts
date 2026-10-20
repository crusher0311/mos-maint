/**
 * Provider errors can contain credential fragments, request bodies and headers.
 * Return only fixed messages and allowlisted diagnostics to clients and logs.
 */
export function concernAssistantFailure(error: unknown) {
  const status = error && typeof error === "object" && "status" in error
    ? (error as { status?: unknown }).status : undefined;
  const category = status === 401 || status === 403 ? "provider_auth"
    : status === 429 ? "provider_limit" : "request_failed";
  return {
    status: 503,
    diagnostic: { category },
    body: {
      error: "The concern assistant is unavailable. Your entries are still here. You can continue without AI-generated questions.",
      code: "CONCERN_ASSISTANT_UNAVAILABLE",
    },
  };
}
