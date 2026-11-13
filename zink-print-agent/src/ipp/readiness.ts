import type { Values } from "./codec";
import { IppDiagnosticError } from "./transport";

/** Safe local status labels only: never include addresses, credentials or raw errors. */
export function inspectionFailure(error: unknown): string {
  const allowed = ["name_resolution_failed", "certificate_rejected", "connection_failed", "inspection_timeout"];
  return error instanceof IppDiagnosticError && allowed.includes(error.code) ? error.code : "attributes_failed";
}

export function printerReadiness(attrs: Values, expectedUuid?: string): string {
  const uuid = attrs["printer-uuid"]?.[0];
  if (typeof uuid !== "string") return "identity_missing";
  if (expectedUuid && uuid.toLowerCase() !== expectedUuid) return "identity_mismatch";
  const accepting = attrs["printer-is-accepting-jobs"]?.[0];
  if (accepting === undefined) return "accepting_jobs_missing";
  if (accepting !== true) return "not_accepting_jobs";
  if (attrs["printer-state"]?.[0] === 5) return "printer_stopped";
  return "ready";
}
