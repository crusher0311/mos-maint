/** Safe, browser-compatible failure contract. Never return driver messages. */
export type ReportFailureKind = "deadline" | "unavailable" | "schema" | "query" | "access" | "unknown";
export type ReportRunFailure = {
  message: string;
  retryable: boolean;
  stage?: string;
  kind?: ReportFailureKind;
  correlationId?: string;
};
const messages: Record<ReportFailureKind, string> = {
  deadline: "The report exceeded its time limit. Retry, or choose a shorter date range.",
  unavailable: "The reporting database is temporarily unavailable. Retry shortly; contact support if this continues.",
  schema: "Required reporting database setup is unavailable. Contact support to check the database deployment before retrying.",
  query: "The report query could not be executed. Contact support before retrying.",
  access: "Reporting access or the authorized locations changed. Reload the page and check your reporting scope.",
  unknown: "The report could not finish. Contact support with the reference below.",
};
const stages = new Set(["authorization", "query", "business", "labor", "events", "technician", "database_queue", "assembly", "persist"]);
export function safeReportFailure(error: Partial<ReportRunFailure>, fallbackId: string): ReportRunFailure {
  const kind = error.kind && Object.hasOwn(messages, error.kind) ? error.kind : "unknown";
  return {
    kind, message: messages[kind],
    retryable: kind === "deadline" || kind === "unavailable",
    stage: stages.has(error.stage || "") ? error.stage : "query",
    correlationId: /^[a-zA-Z0-9_-]{1,100}$/.test(error.correlationId || "") ? error.correlationId : fallbackId,
  };
}
export function reportFailureText(error: ReportRunFailure) {
  return `${error.message} Failed stage: ${(error.stage || "query").replaceAll("_", " ")}. Support reference: ${error.correlationId || "unavailable"}.`;
}
