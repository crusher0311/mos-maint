/**
 * Cloud client: outbound HTTPS poll + ack.
 *
 * Speaks the contract defined in contract.ts. Uses the global fetch (Node 18+).
 * All requests carry the shop API key as a bearer token. Network / non-2xx
 * responses throw so the agent's retry/backoff logic can react.
 */

import type {
  AckJobRequest,
  AckJobResponse,
  PollJobsResponse,
  PrintJob,
} from "./contract";

export interface CloudClientOptions {
  baseUrl: string;
  apiKey: string;
  printerId?: string;
  agentVersion?: string;
  /** Per-request timeout in ms. */
  requestTimeoutMs?: number;
  /** Injectable fetch (for tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

export class CloudClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly printerId?: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: CloudClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.printerId = opts.printerId;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { ...this.authHeaders(), ...(init.headers || {}) },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET pending jobs. Returns [] when the queue is empty. */
  async pollJobs(): Promise<PrintJob[]> {
    const qs = this.printerId
      ? `?printerId=${encodeURIComponent(this.printerId)}`
      : "";
    const res = await this.request(`/api/print-agent/jobs${qs}`, {
      method: "GET",
    });
    if (!res.ok) {
      throw new Error(`poll failed: HTTP ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as PollJobsResponse;
    if (!body || !Array.isArray(body.jobs)) {
      throw new Error("poll response missing jobs[] array");
    }
    return body.jobs;
  }

  /** POST the terminal outcome of a single job. */
  async ackJob(jobId: string, ack: AckJobRequest): Promise<AckJobResponse> {
    const res = await this.request(
      `/api/print-agent/jobs/${encodeURIComponent(jobId)}/ack`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ack),
      },
    );
    if (!res.ok) {
      throw new Error(`ack failed: HTTP ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as AckJobResponse;
  }
}
