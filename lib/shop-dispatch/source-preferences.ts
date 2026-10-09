import type { Visit } from "./model";

// Deliberately independent of the dashboard's saved preferences.
export const DEFAULT_SOURCE_STATUSES = [
  "InspectionInProgress", "Unassigned", "WorkAuthorized", "EstimateCompleted",
  "EstimatePresented", "EstimateRejected", "WaitingForParts", "VehicleInBay",
  "VehicleReadyForPickup", "Deferred", "WorkCompleted",
];
export const terminalSourceStatus = (status: string | null | undefined) =>
  /^(invoice|invoiced|closed|void|deleted|closedinvoiced|closedvoid|posted|cancelled|canceled|completed)$/i.test(status ?? "");

export function isVisitVisible(visit: Pick<Visit, "provider" | "sourceStatus">, statuses = DEFAULT_SOURCE_STATUSES): boolean {
  return visit.provider !== "protractor" || statuses.includes(visit.sourceStatus ?? "Unknown");
}

export function normalizeRoNumber(value: string): string {
  return value.trim().replace(/^(?:ro\s*#?\s*|#\s*)/i, "").trim();
}
