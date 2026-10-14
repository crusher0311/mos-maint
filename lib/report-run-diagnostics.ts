import { AsyncLocalStorage } from "node:async_hooks";
import { safeReportFailure, type ReportFailureKind } from "./report-run-failure";

export const reportRunDiagnostics = new AsyncLocalStorage<{ correlationId: string }>();

/** Retain only structural driver diagnostics, not SQL, detail, parameters or messages. */
export function redactedReportCause(error: unknown) {
  const chain: Array<{ code?: string; routine?: string }> = [];
  const seen = new Set<unknown>();
  for (let current: any = error; current && typeof current === "object" && !seen.has(current) && chain.length < 5; current = current.cause) {
    seen.add(current);
    const code = typeof current.code === "string" && /^[A-Z0-9_]{2,40}$/.test(current.code) ? current.code : undefined;
    const routine = typeof current.routine === "string" && /^[a-zA-Z_]{1,80}$/.test(current.routine) ? current.routine : undefined;
    chain.push({ ...(code ? { code } : {}), ...(routine ? { routine } : {}) });
  }
  return chain;
}

export function classifyReportFailure(error: unknown, stage: string, correlationId: string) {
  const codes = redactedReportCause(error).map(item => item.code || "");
  const value = error as { kind?: string; stage?: string; name?: string; message?: string };
  let kind: ReportFailureKind = "unknown";
  if (value?.name === "ReportingQueryError" && value?.kind === "validation" && value?.stage === "invoice" &&
    value?.message === "Invoice evidence exceeds 100,000 stored work orders. Select fewer locations.") kind = "invoice_scope_limit";
  else if (value?.kind === "deadline" || codes.includes("57014")) kind = "deadline";
  else if (codes.some(code => ["42P01", "42703", "3F000"].includes(code))) kind = "schema";
  else if (["MongoServerSelectionError", "MongoNetworkError", "MongoNetworkTimeoutError"].includes(value?.name || "") ||
    codes.some(code => /^(08|53|57P|40)/.test(code) || ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "CONNECT_TIMEOUT", "CONNECTION_CLOSED"].includes(code))) kind = "unavailable";
  else if (codes.some(code => /^(22|23|42)/.test(code)) || value?.name === "ReportDefinitionError") kind = "query";
  else if (value?.name === "ReportingScopeError" || /Requester access|Authorized reporting scope changed|^Forbidden$|^Report (version )?not found$/.test(value?.message || "")) kind = "access";
  return safeReportFailure({ kind, stage: value?.stage || stage, correlationId }, correlationId);
}
