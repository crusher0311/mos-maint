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

/** ZINK print options that map directly to the agent's XML header fields. */
export interface ZinkPrintOptions {
  /** Print-head width in pixels. Always 640 for current ZINK hardware. */
  width?: number;
  /** 1 = full cut, 0 = kiss cut. */
  cut?: 0 | 1;
  /** 0 = vivid, 1 = draft. */
  speed?: 0 | 1;
}

/** Optional per-job printer override (falls back to the agent config). */
export interface JobPrinterTarget {
  /** mDNS name (e.g. "zink.local"), hostname, or static IP. */
  address: string;
  /** TCP port. Defaults to 9100 when omitted. */
  port?: number;
}

/** Lifecycle states a job moves through. */
export type PrintJobStatus = "pending" | "in-flight" | "done" | "failed";

/** Terminal outcome reported by the agent on ack. */
export type JobOutcome = "success" | "failure";

/**
 * A single pending print job as handed to the agent by the cloud.
 * Mirrors `PrintJob` in the agent contract — keep in sync.
 */
export interface AgentPrintJob {
  /** Stable, unique job id used when acking (the Mongo `_id` as a string). */
  id: string;
  /**
   * The image to print, base64-encoded JPEG bytes (bare base64, no data
   * URI prefix).
   */
  imageBase64: string;
  /** Optional printer override for this job. */
  printer?: JobPrinterTarget;
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
   * matching `printerId` (or with a per-job printer override absent) will
   * claim it. Per-device routing UX lands in Milestone 3.
   */
  printerId?: string | null;
  /** Optional per-job printer override applied by the agent. */
  printer?: JobPrinterTarget;
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
  /** Default cut mode applied to outgoing jobs (1 = full, 0 = kiss). */
  defaultCut: 0 | 1;
  /** Default speed applied to outgoing jobs (0 = vivid, 1 = draft). */
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
