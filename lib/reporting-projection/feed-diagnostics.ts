/** Allowlisted categories only: never return messages, stacks, addresses,
 * resume tokens, payloads or arbitrary driver fields. */
export function feedFailureCategory(error: unknown) {
  const e = error as { name?: unknown; code?: unknown } | null;
  if ([260, 280, 286].includes(Number(e?.code))) return "history_gap";
  if (["MongoOperationTimeoutError", "MongoNetworkTimeoutError", "TimeoutError"].includes(String(e?.name)) ||
      [50, 262].includes(Number(e?.code)) || e?.code === "ETIMEDOUT") return "timeout";
  if (e?.name === "MongoServerSelectionError") return "server_selection";
  if (e?.name === "MongoNetworkError" || [6, 7, 89, 9001].includes(Number(e?.code)) ||
      ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ENOTFOUND", "EAI_AGAIN"].includes(String(e?.code))) return "network";
  if ([13, 18].includes(Number(e?.code))) return "authorization";
  if (e?.name === "AbortError") return "cancelled";
  if (e?.code === "55P03") return "database_lock_timeout";
  if (e?.code === "57014") return "database_query_cancelled";
  if (e?.code === "25P02") return "database_transaction_aborted";
  return "unknown";
}
