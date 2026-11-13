/** Client-safe Saved IPP protocol. No LAN addresses or bearer credentials. */
export const IPP_PROTOCOL = "mos-ipp-png-v1" as const;
export type LabelKind = "sticker" | "keytag";
export interface PrintStock { width: number; height: number }
export interface SavedDestination {
  id: string;
  printerId: string;
  agentId: string;
  name: string;
  model: string;
  kind: LabelKind;
  stock: PrintStock;
  revision: string;
  online: boolean;
  supported: boolean;
}
export interface DestinationSettings {
  shopId: number;
  kind: LabelKind;
  destinations: SavedDestination[];
  defaultDestinationId: string | null;
  canManage: boolean;
}
export type IppStatus = "queued" | "claimed" | "printer-accepted" | "completed" | "failed" | "unknown";
export interface IppStatusView {
  jobId: string;
  status: IppStatus;
  destinationId: string;
  error?: string;
}
export interface IppWireJob {
  protocol: typeof IPP_PROTOCOL;
  id: string;
  claimToken: string;
  printerId: string;
  kind: LabelKind;
  stock: PrintStock;
  revision: string;
  imageBase64: string;
}
export const IPP_STATUS_LABELS: Record<IppStatus, string> = {
  queued: "Accepted by cloud queue",
  claimed: "Sending to printer — completion not confirmed",
  "printer-accepted": "Accepted by printer — completion not confirmed",
  completed: "Printer confirmed completion",
  failed: "Print failed — check printer before printing again",
  unknown: "Outcome unknown — check printer; do not automatically reprint",
};
