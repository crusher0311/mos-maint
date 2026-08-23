/**
 * Cloud <-> Agent request/response contract.
 *
 * This is the canonical definition of the polling protocol the local print
 * agent speaks to the MOS Tools cloud. Milestone 2 (the cloud-side queue +
 * auth endpoints) MUST implement the matching server side against these
 * shapes. Keep this file in sync with the server contract.
 *
 * Transport: outbound HTTPS only. The agent never accepts inbound
 * connections; it polls the cloud on an interval and acks each job.
 *
 * Auth: every request carries the shop API key as a bearer token:
 *     Authorization: Bearer <shopApiKey>
 *
 * Endpoints (paths are relative to the configured cloudBaseUrl):
 *
 *   GET  /api/print-agent/jobs            -> PollJobsResponse
 *        Optional query param `printerId` lets a shop with multiple agents
 *        scope the poll to jobs routed to a specific device.
 *
 *   POST /api/print-agent/jobs/:id/ack    body: AckJobRequest -> AckJobResponse
 *        Reports the terminal outcome of a single job so the cloud can
 *        mark it done / failed and stop handing it back out.
 */

/** ZINK print options that map directly to the XML header fields. */
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

/**
 * A single pending print job handed to the agent by the cloud.
 * The cloud never supplies a LAN target: `printerId` selects the polling
 * agent, while the physical host/port come only from that agent's local
 * config.
 */
export interface PrintJob {
  /** Stable, unique job id used when acking. */
  id: string;
  /**
   * The image to print, base64-encoded JPEG bytes. May be a bare base64
   * string or a `data:image/jpeg;base64,...` data URI.
   */
  imageBase64: string;
  /** Optional ZINK print options. Sensible defaults applied when omitted. */
  options?: ZinkPrintOptions;
}

/** Response body for GET /api/print-agent/jobs. */
export interface PollJobsResponse {
  jobs: PrintJob[];
}

/** Terminal outcome reported for a job. */
export type JobOutcome = "success" | "failure";

/** Request body for POST /api/print-agent/jobs/:id/ack. */
export interface AckJobRequest {
  status: JobOutcome;
  /** Human-readable error message when status === "failure". */
  error?: string;
  /** Wall-clock time the agent spent handling the job, in ms. */
  durationMs?: number;
  /** Agent version string, for cloud-side observability. */
  agentVersion?: string;
}

/** Response body for POST /api/print-agent/jobs/:id/ack. */
export interface AckJobResponse {
  ok: boolean;
}
