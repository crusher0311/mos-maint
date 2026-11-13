import { createHash } from "node:crypto";
import { EnrollmentStore } from "./enrollment";
import { IppClient, type EnrolledPrinter } from "./client";
import { createExchange } from "./transport";
import { IppJournal, IppWorker, type IppJob } from "./journal";
import type { AgentConfig } from "../config";
const PROTOCOL = "mos-ipp-png-v1";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function revision(printer: EnrolledPrinter) {
  return hash([printer.id, printer.kind, printer.stock.width, printer.stock.height, printer.model]);
}
export interface IppCloud { ippControl(body: Record<string, unknown>, poll?: boolean): Promise<any> }

/** Outbound-only IPP lane inside the existing executable. No LAN listener. */
export class IppRuntime {
  private inventory: { id: string; name: string; model: string; kind: string; stock: { width: number; height: number }; online: boolean }[] = [];
  private refreshedAt = 0;
  private enrollmentHash = "";
  private readonly store: EnrollmentStore;
  private readonly journal: IppJournal;
  constructor(private readonly config: AgentConfig, private readonly cloud: IppCloud,
    private readonly client = new IppClient(createExchange(2000))) {
    if (!config.ipp) throw new Error("IPP configuration required");
    this.store = new EnrollmentStore(config.ipp.enrollmentFile);
    this.journal = new IppJournal(config.ipp.journalDirectory,
      hash([config.cloudBaseUrl, config.shopApiKey, config.ipp.installationId]));
  }
  async runOnce(): Promise<number> {
    const printers = this.store.list();
    const fingerprint = hash(printers);
    if (fingerprint !== this.enrollmentHash || Date.now() - this.refreshedAt > 60000) {
      const inventory: typeof this.inventory = [];
      // At most four bounded two-operation inspections run concurrently.
      for (let i = 0; i < printers.length; i += 4) {
        inventory.push(...await Promise.all(printers.slice(i, i + 4).map(async p => {
          let online = false;
          try {
            const attrs = await this.client.inspect(p.uri);
            online = attrs["printer-uuid"]?.[0]?.toString().toLowerCase() === p.uuid &&
              attrs["printer-is-accepting-jobs"]?.[0] === true && attrs["printer-state"]?.[0] !== 5;
          } catch { /* Explicit offline status; never another printer. */ }
          return { id: p.id, name: p.name, kind: p.kind, model: p.model, stock: p.stock, online };
        })));
      }
      this.inventory = inventory; this.enrollmentHash = fingerprint; this.refreshedAt = Date.now();
    }
    const identity = { installationId: this.config.ipp!.installationId };
    const response = await this.cloud.ippControl({ ...identity, action: "poll", printers: this.inventory }, true);
    if (!Array.isArray(response?.jobs) || response.jobs.length > 1) throw new Error("Invalid IPP cloud response");
    for (const wire of response.jobs) {
      if (wire?.protocol !== PROTOCOL || typeof wire.id !== "string" || !/^[a-f0-9]{24}$/.test(wire.id) ||
          typeof wire.claimToken !== "string" || typeof wire.imageBase64 !== "string" ||
          wire.imageBase64.length > 4 * Math.ceil(4 * 1024 * 1024 / 3) ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(wire.imageBase64) || typeof wire.reconcileOnly !== "boolean")
        throw new Error("Invalid IPP cloud job");
      const printer = printers.find(p => p.id === wire.printerId);
      const job: IppJob = { id: wire.id, printerId: wire.printerId, kind: wire.kind,
        stock: wire.stock, png: Buffer.from(wire.imageBase64, "base64") };
      let evidence = this.journal.read(job);
      if (!evidence && wire.reconcileOnly) {
        // Lost initial poll response / missing journal: never assume unsent.
        evidence = { outcome: "unknown", reason: "Claim was already delivered; no local send evidence" };
      } else if (!evidence && (!printer || revision(printer) !== wire.revision)) {
        evidence = { outcome: "failed", reason: "Enrollment or stock changed" };
      } else if (!evidence) {
        evidence = await new IppWorker(printers, this.journal, this.client).process(job);
      } else if (evidence.outcome === "printer-accepted" && printer) {
        const next = await this.client.status(printer, evidence.printerJobId);
        if (next.outcome !== "unknown") {
          this.journal.finish(job, next); evidence = next;
        }
      }
      await this.cloud.ippControl({ ...identity, action: "ack", jobId: wire.id,
        claimToken: wire.claimToken, status: evidence!.outcome,
        ...("printerJobId" in evidence! ? { printerJobId: evidence!.printerJobId } : {}) });
    }
    return response.jobs.length;
  }
}
