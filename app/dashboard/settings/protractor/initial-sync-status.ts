export type InitialSyncState = "pending" | "running" | "complete" | "failed" | null;

export type ProtractorSyncStatus = {
  configured: boolean;
  initialSyncState?: InitialSyncState;
  initialSyncVehicles?: number | null;
  initialSyncError?: string | null;
};

export const STATUS_POLL_INTERVAL_MS = 5000;
export const MAX_STATUS_POLLS = 24;

export function shouldPollInitialSync(status: ProtractorSyncStatus | null): boolean {
  return !!status?.configured &&
    (status.initialSyncState === "pending" || status.initialSyncState === "running");
}

export function initialSyncPresentation(status: ProtractorSyncStatus | null): {
  title: string;
  detail: string;
  tone: "neutral" | "progress" | "success" | "error";
} {
  if (!status?.configured) {
    return { title: "Not connected", detail: "", tone: "neutral" };
  }
  switch (status.initialSyncState) {
    case "pending":
      return {
        title: "Connected — history import pending",
        detail: "Your connection is saved. The initial vehicle and service history import is queued and has not started yet.",
        tone: "progress",
      };
    case "running":
      return {
        title: "Connected — importing history",
        detail: "The initial vehicle and service history import is in progress.",
        tone: "progress",
      };
    case "complete":
      return {
        title: "Connected — history import complete",
        detail: status.initialSyncVehicles != null
          ? `Initial import finished with ${status.initialSyncVehicles} service items cached.`
          : "The initial import has finished.",
        tone: "success",
      };
    case "failed":
      return {
        title: "Connected — history import failed",
        detail: status.initialSyncError || "The initial import did not finish. Contact support or try syncing again.",
        tone: "error",
      };
    default:
      return {
        title: "Connected — history import status unavailable",
        detail: "The connection is saved, but the initial import has not been confirmed complete.",
        tone: "neutral",
      };
  }
}