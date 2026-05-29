/**
 * Print agent orchestrator.
 *
 * Owns the poll loop:
 *   1. Poll the cloud for pending jobs.
 *   2. For each job: resolve the printer address, build the XML header,
 *      decode the JPEG, send over port 9100, then ack success/failure.
 *   3. Sleep pollIntervalMs and repeat.
 *
 * Resilience:
 *   - A poll that throws (network down, cloud 5xx) triggers exponential
 *     backoff with jitter, capped at maxBackoffMs. A successful poll resets
 *     the backoff.
 *   - A single bad job never crashes the loop: send/ack failures are caught,
 *     logged, and reported back to the cloud as a "failure" ack when possible.
 *
 * Every external interaction is injectable so the loop can be unit-tested
 * against mocks without real network or printer hardware.
 */

import type { AckJobRequest, PrintJob } from "./contract";
import { buildZinkHeader } from "./xml";
import { base64ToImageBuffer } from "./image";
import { resolveAddress, sendToPrinter, type MdnsResolver } from "./printer";
import { createLogger, type Logger } from "./logger";

export interface AgentRuntimeConfig {
  printer: { address: string; port: number };
  pollIntervalMs: number;
  mdnsTimeoutMs: number;
  connectTimeoutMs: number;
  agentVersion?: string;
}

export interface CloudPort {
  pollJobs(): Promise<PrintJob[]>;
  ackJob(jobId: string, ack: AckJobRequest): Promise<unknown>;
}

export interface PrinterPort {
  resolveAddress(address: string, timeoutMs: number): Promise<string>;
  sendToPrinter(
    host: string,
    header: string,
    jpeg: Buffer,
    opts: { port: number; connectTimeoutMs: number },
  ): Promise<void>;
}

export interface AgentDeps {
  cloud: CloudPort;
  printer?: PrinterPort;
  logger?: Logger;
  sleep?: (ms: number) => Promise<void>;
  mdnsResolver?: MdnsResolver;
  /** Backoff tuning. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Deterministic jitter source for tests; defaults to Math.random. */
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Build the default printer port backed by the real net/mDNS implementation. */
function makeDefaultPrinterPort(mdnsResolver?: MdnsResolver): PrinterPort {
  return {
    resolveAddress: (address, timeoutMs) =>
      resolveAddress(address, { timeoutMs, mdnsResolver }),
    sendToPrinter: (host, header, jpeg, opts) =>
      sendToPrinter(host, header, jpeg, opts),
  };
}

export class PrintAgent {
  private readonly cfg: AgentRuntimeConfig;
  private readonly cloud: CloudPort;
  private readonly printer: PrinterPort;
  private readonly log: Logger;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly random: () => number;

  private running = false;
  private consecutivePollFailures = 0;

  constructor(cfg: AgentRuntimeConfig, deps: AgentDeps) {
    this.cfg = cfg;
    this.cloud = deps.cloud;
    this.printer = deps.printer ?? makeDefaultPrinterPort(deps.mdnsResolver);
    this.log = deps.logger ?? createLogger();
    this.sleep = deps.sleep ?? defaultSleep;
    this.baseBackoffMs = deps.baseBackoffMs ?? 1000;
    this.maxBackoffMs = deps.maxBackoffMs ?? 60000;
    this.random = deps.random ?? Math.random;
  }

  /** Exponential backoff with full jitter for the Nth consecutive failure. */
  computeBackoff(failureCount: number): number {
    const exp = Math.min(
      this.maxBackoffMs,
      this.baseBackoffMs * 2 ** Math.max(0, failureCount - 1),
    );
    // Full jitter: random between 0 and exp.
    return Math.floor(this.random() * exp);
  }

  /** Handle exactly one job end-to-end. Never throws. */
  async processJob(job: PrintJob): Promise<boolean> {
    const startedAt = Date.now();
    try {
      const target = job.printer ?? this.cfg.printer;
      const port = job.printer?.port ?? this.cfg.printer.port;

      const header = buildZinkHeader(job.options ?? {});
      const jpeg = base64ToImageBuffer(job.imageBase64);

      const host = await this.printer.resolveAddress(
        target.address,
        this.cfg.mdnsTimeoutMs,
      );

      this.log.info("printing job", {
        jobId: job.id,
        host,
        port,
        bytes: jpeg.length,
      });

      await this.printer.sendToPrinter(host, header, jpeg, {
        port,
        connectTimeoutMs: this.cfg.connectTimeoutMs,
      });

      const durationMs = Date.now() - startedAt;
      await this.safeAck(job.id, {
        status: "success",
        durationMs,
        agentVersion: this.cfg.agentVersion,
      });
      this.log.info("job printed", { jobId: job.id, durationMs });
      return true;
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const message = err instanceof Error ? err.message : String(err);
      this.log.error("job failed", { jobId: job.id, error: message, durationMs });
      await this.safeAck(job.id, {
        status: "failure",
        error: message,
        durationMs,
        agentVersion: this.cfg.agentVersion,
      });
      return false;
    }
  }

  /** Ack a job, swallowing ack-transport errors so the loop survives. */
  private async safeAck(jobId: string, ack: AckJobRequest): Promise<void> {
    try {
      await this.cloud.ackJob(jobId, ack);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn("ack failed", { jobId, status: ack.status, error: message });
    }
  }

  /**
   * Run a single poll-and-process cycle.
   * Returns the number of jobs processed, or throws if the poll itself fails
   * (the caller translates that into backoff).
   */
  async runOnce(): Promise<number> {
    const jobs = await this.cloud.pollJobs();
    if (jobs.length === 0) {
      this.log.debug("no pending jobs");
      return 0;
    }
    this.log.info("received jobs", { count: jobs.length });
    for (const job of jobs) {
      await this.processJob(job);
    }
    return jobs.length;
  }

  /**
   * Start the continuous poll loop. Resolves only after stop() is called.
   * The optional maxIterations bound keeps tests finite.
   */
  async start(maxIterations = Infinity): Promise<void> {
    this.running = true;
    let iterations = 0;
    this.log.info("agent started", {
      printer: this.cfg.printer.address,
      port: this.cfg.printer.port,
      pollIntervalMs: this.cfg.pollIntervalMs,
    });

    while (this.running && iterations < maxIterations) {
      iterations += 1;
      try {
        await this.runOnce();
        this.consecutivePollFailures = 0;
        if (!this.running) break;
        await this.sleep(this.cfg.pollIntervalMs);
      } catch (err) {
        this.consecutivePollFailures += 1;
        const message = err instanceof Error ? err.message : String(err);
        const backoff = this.computeBackoff(this.consecutivePollFailures);
        this.log.warn("poll failed; backing off", {
          error: message,
          consecutiveFailures: this.consecutivePollFailures,
          backoffMs: backoff,
        });
        if (!this.running) break;
        await this.sleep(backoff);
      }
    }
    this.log.info("agent stopped", { iterations });
  }

  stop(): void {
    this.running = false;
  }

  get pollFailureCount(): number {
    return this.consecutivePollFailures;
  }
}
