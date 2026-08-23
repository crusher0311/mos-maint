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
import {
  MAX_CONTROL_RESPONSE_BYTES,
  MAX_POLL_RESPONSE_BYTES,
} from "./limits";

export interface CloudClientOptions {
  baseUrl: string;
  apiKey: string;
  printerId?: string;
  agentVersion?: string;
  /** Per-request timeout in ms. */
  requestTimeoutMs?: number;
  /** Test seam; production defaults to the synchronized job payload cap. */
  maxPollResponseBytes?: number;
  /** Injectable fetch (for tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

export class CloudClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly printerId?: string;
  private readonly agentVersion?: string;
  private readonly requestTimeoutMs: number;
  private readonly maxPollResponseBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: CloudClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.printerId = opts.printerId;
    this.agentVersion = opts.agentVersion;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxPollResponseBytes =
      opts.maxPollResponseBytes ?? MAX_POLL_RESPONSE_BYTES;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  private async readBodyLimited(res: Response, maxBytes: number): Promise<string> {
    const contentLength = Number(res.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`cloud response exceeds ${maxBytes} byte limit`);
    }
    if (!res.body) return "";

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new Error(`cloud response exceeds ${maxBytes} byte limit`);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString(
      "utf8",
    );
  }

  private async request(
    path: string,
    init: RequestInit,
    maxResponseBytes: number,
  ): Promise<{ response: Response; bodyText: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { ...this.authHeaders(), ...(init.headers || {}) },
      });
      const bodyText = await this.readBodyLimited(response, maxResponseBytes);
      return { response, bodyText };
    } finally {
      clearTimeout(timer);
    }
  }

  private throwResponseError(
    action: "poll" | "ack",
    res: Response,
    rawBody: string,
  ): never {
    let detail = "";
    try {
      const raw = rawBody.trim();
      if (raw) {
        try {
          const body = JSON.parse(raw) as {
            error?: string;
            message?: string;
            requestId?: string;
          };
          detail = [body.error, body.message, body.requestId && `request ${body.requestId}`]
            .filter(Boolean)
            .join(": ");
        } catch {
          detail = raw.slice(0, 300);
        }
      }
    } catch {}
    throw new Error(
      `${action} failed: HTTP ${res.status} ${res.statusText}` +
        (detail ? ` — ${detail}` : ""),
    );
  }

  /** GET pending jobs. Returns [] when the queue is empty. */
  async pollJobs(): Promise<PrintJob[]> {
    const qs = this.printerId
      ? `?printerId=${encodeURIComponent(this.printerId)}`
      : "";
    const { response: res, bodyText } = await this.request(
      `/api/print-agent/jobs${qs}`,
      {
        method: "GET",
        headers: this.agentVersion
          ? { "X-Agent-Version": this.agentVersion }
          : undefined,
      },
      this.maxPollResponseBytes,
    );
    if (!res.ok) {
      return this.throwResponseError("poll", res, bodyText);
    }
    let body: PollJobsResponse;
    try {
      body = JSON.parse(bodyText) as PollJobsResponse;
    } catch {
      throw new Error("poll response was not valid JSON");
    }
    if (!body || !Array.isArray(body.jobs)) {
      throw new Error("poll response missing jobs[] array");
    }
    return body.jobs;
  }

  /** POST the terminal outcome of a single job. */
  async ackJob(jobId: string, ack: AckJobRequest): Promise<AckJobResponse> {
    const { response: res, bodyText } = await this.request(
      `/api/print-agent/jobs/${encodeURIComponent(jobId)}/ack`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ack),
      },
      MAX_CONTROL_RESPONSE_BYTES,
    );
    if (!res.ok) {
      return this.throwResponseError("ack", res, bodyText);
    }
    return JSON.parse(bodyText) as AckJobResponse;
  }
}
