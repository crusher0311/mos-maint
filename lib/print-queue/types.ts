/**
 * ZINK Cloud Print Queue — shared types (task #542, Milestone 2).
 *
 * The cloud side of the ZINK print pipeline. The cloud NEVER opens a
 * socket to a printer; it only persists jobs in MongoDB (scoped by
 * `shopId`) and serves them to authenticated shop agents that poll.
 *
 * The agent-facing wire shapes here MUST stay in sync with the agent's
 * `zink-print-agent/src/contract.ts`. The internal persisted document
 * (`PrintJobDoc`) is a superset that adds queue bookkeeping the agent
 * never sees.
 */

import type { ObjectId } from "mongodb";

/** Keep synchronized with zink-print-agent/src/limits.ts. */
export const MAX_PRINT_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_PRINT_IMAGE_BASE64_CHARS =
  4 * Math.ceil(MAX_PRINT_IMAGE_BYTES / 3);
export const MAX_PRINT_IMAGE_INPUT_CHARS =
  MAX_PRINT_IMAGE_BASE64_CHARS + 128;
export const MAX_PRINT_REQUEST_BODY_BYTES =
  MAX_PRINT_IMAGE_BASE64_CHARS + 64 * 1024;

export class PrintPayloadTooLargeError extends Error {
  constructor(message = "Print payload exceeds the size limit") {
    super(message);
    this.name = "PrintPayloadTooLargeError";
  }
}

/** ZINK print options that map directly to the agent's XML header fields. */
export interface ZinkPrintOptions {
  /**
   * Expected raster width in pixels. Current generated images use 640px.
   * The VC-500W setup XML itself uses width=0 + autofit=1.
   */
  width?: number;
  /** 1 = full cut, 0 = half cut. */
  cut?: 0 | 1;
  /** 0 = vivid (317 lpi), 1 = normal/color (264 lpi). */
  speed?: 0 | 1;
}

/** Lifecycle states a job moves through. */
export type PrintJobStatus = "pending" | "in-flight" | "done" | "failed";

/** Terminal outcome reported by the agent on ack. */
export type JobOutcome = "success" | "failure";

/**
 * A single pending print job as handed to the agent by the cloud.
 * Mirrors `PrintJob` in the agent contract — keep in sync.
 * The physical printer host/port is deliberately absent and remains local
 * agent configuration.
 */
export interface AgentPrintJob {
  /** Stable, unique job id used when acking (the Mongo `_id` as a string). */
  id: string;
  /**
   * The image to print, base64-encoded JPEG bytes (bare base64, no data
   * URI prefix).
   */
  imageBase64: string;
  /** Optional ZINK print options. Sensible defaults applied when omitted. */
  options?: ZinkPrintOptions;
}

/** Response body for GET /api/print-agent/jobs. */
export interface PollJobsResponse {
  jobs: AgentPrintJob[];
}

/** Request body for POST /api/print-agent/jobs/:id/ack. */
export interface AckJobRequest {
  status: JobOutcome;
  error?: string;
  durationMs?: number;
  agentVersion?: string;
}

/** Response body for POST /api/print-agent/jobs/:id/ack. */
export interface AckJobResponse {
  ok: boolean;
}

/** Persisted print-job document (the queue row). */
export interface PrintJobDoc {
  _id?: ObjectId;
  /** Internal MOS shop id — every read/write is scoped by this. */
  shopId: number;
  status: PrintJobStatus;
  /** base64-encoded JPEG bytes (bare base64, no data URI prefix). */
  imageBase64: string;
  /**
   * Optional device routing hint. When set, only an agent polling with a
   * matching `printerId` will claim it. Physical LAN addresses are local-agent
   * configuration and are never part of the cloud-to-agent job contract.
   */
  printerId?: string | null;
  /** ZINK options, defaulted from the shop's printer config at enqueue. */
  options?: ZinkPrintOptions;
  /** What produced this job, for triage. */
  kind?: "sticker" | "keytag" | "raw";
  /** Free-form metadata (RO number, VIN, requester) for observability. */
  meta?: Record<string, unknown>;
  attempts: number;
  /** Terminal error message when status === "failed". */
  error?: string | null;
  durationMs?: number | null;
  agentVersion?: string | null;
  createdAt: Date;
  updatedAt: Date;
  claimedAt?: Date | null;
  completedAt?: Date | null;
  failedAt?: Date | null;
}

/** Per-shop printer configuration record. */
export interface PrinterConfigDoc {
  _id?: ObjectId;
  shopId: number;
  /**
   * Optional device id. Milestone 2 stores a single default config per
   * shop (`printerId` absent/"default"). Milestone 3 adds multiple rows
   * for per-device routing.
   */
  printerId?: string | null;
  /** mDNS name, hostname, or static IP of the printer. */
  address: string;
  /** TCP port. Defaults to 9100. */
  port: number;
  /** Default cut mode applied to outgoing jobs (1 = full, 0 = half). */
  defaultCut: 0 | 1;
  /** Default speed applied to outgoing jobs (0 = vivid, 1 = normal/color). */
  defaultSpeed: 0 | 1;
  /** Default print-head width in pixels. */
  defaultWidth: number;
  createdAt: Date;
  updatedAt: Date;
}

/** ZINK hardware defaults used when a shop has no printer config yet. */
export const PRINTER_DEFAULTS = {
  port: 9100,
  defaultCut: 1 as 0 | 1,
  defaultSpeed: 0 as 0 | 1,
  defaultWidth: 640,
};

/**
 * How long an in-flight job may sit before it is considered stalled and
 * re-servable to the next polling agent. Mirrors the worker-queue
 * visibility-timeout idea — a crashed agent self-heals on the next poll.
 */
export const STALE_INFLIGHT_MS = 5 * 60 * 1000;

/**
 * Per-agent poll heartbeat (task #543, Milestone 3). Every time a shop
 * agent polls `/api/print-agent/jobs` the cloud records the moment so the
 * platform-admin dashboard can show "agent online / last seen". One row
 * per (shopId, printerId) — agents polling without a printerId collapse to
 * the `DEFAULT_PRINTER_ID` bucket. This is observability only; it never
 * gates job claiming.
 */
export interface AgentHeartbeatDoc {
  _id?: ObjectId;
  shopId: number;
  /** Normalized device id — `DEFAULT_PRINTER_ID` when the agent polls untagged. */
  printerId: string;
  lastPollAt: Date;
  agentVersion?: string | null;
}

/** Bucket a null/empty printerId collapses to for config + heartbeat rows. */
export const DEFAULT_PRINTER_ID = "default";

/**
 * An agent is considered "online" if its last poll landed within this
 * window. Agents poll on a short interval (seconds), so a 2-minute window
 * tolerates a few missed ticks before flagging it offline in the admin UI.
 */
export const AGENT_ONLINE_THRESHOLD_MS = 2 * 60 * 1000;
