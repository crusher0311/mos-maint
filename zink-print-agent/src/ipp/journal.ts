import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { IppClient, type EnrolledPrinter, type SubmissionEvidence } from "./client";
import type { Stock } from "./media";

export interface IppJob {
  id: string;
  printerId: string;
  kind: "sticker" | "keytag";
  stock: Stock;
  png: Buffer;
}
interface RecordEntry { version: 1; fingerprint: string; evidence?: SubmissionEvidence }

/**
 * Durable no-resend boundary, scoped to one installation and cloud shop.
 * Atomic exclusive creation fences concurrent processes, not just promises.
 * Records are retained: deleting them would erase physical-send evidence.
 */
export class IppJournal {
  constructor(private readonly directory: string, private readonly scope: string) {
    if (!scope || scope.length > 200) throw new Error("A shop/installation journal scope is required");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  private filename(id: string): string {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid logical job ID");
    return path.join(this.directory, createHash("sha256").update(`${this.scope}\0${id}`).digest("hex") + ".json");
  }
  fingerprint(job: IppJob): string {
    return createHash("sha256").update(JSON.stringify([job.printerId, job.kind, job.stock.width, job.stock.height]))
      .update(job.png).digest("hex");
  }
  read(job: IppJob): SubmissionEvidence | undefined {
    let text: string;
    try { text = fs.readFileSync(this.filename(job.id), "utf8"); }
    catch (error: any) { if (error.code === "ENOENT") return undefined; throw error; }
    let record: RecordEntry;
    try { record = JSON.parse(text); }
    catch { return { outcome: "unknown", reason: "Submission journal is damaged; do not resend" }; }
    if (record.version !== 1 || record.fingerprint !== this.fingerprint(job))
      return { outcome: "unknown", reason: "Logical submission identity conflicts; do not resend" };
    return record.evidence ?? { outcome: "unknown", reason: "Submission may have started before interruption; do not resend" };
  }
  begin(job: IppJob): boolean {
    let fd: number;
    try { fd = fs.openSync(this.filename(job.id), "wx", 0o600); }
    catch (error: any) { if (error.code === "EEXIST") return false; throw error; }
    try {
      fs.writeFileSync(fd, JSON.stringify({ version: 1, fingerprint: this.fingerprint(job) }));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    this.syncDirectory();
    return true;
  }
  finish(job: IppJob, evidence: SubmissionEvidence): void {
    const filename = this.filename(job.id), temp = `${filename}.${process.pid}.tmp`;
    const fd = fs.openSync(temp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ version: 1, fingerprint: this.fingerprint(job), evidence }));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temp, filename);
    this.syncDirectory();
  }
  private syncDirectory(): void {
    // Windows does not expose directory fsync through Node. File flush is still
    // mandatory; power-loss durability remains a physical pilot acceptance item.
    if (process.platform === "win32") return;
    const fd = fs.openSync(this.directory, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  acquirePrinter(printerId: string): (() => void) | undefined {
    const name = path.join(this.directory, createHash("sha256")
      .update(`printer\0${this.scope}\0${printerId}`).digest("hex") + ".lock");
    let fd: number;
    try { fd = fs.openSync(name, "wx", 0o600); }
    catch (error: any) { if (error.code === "EEXIST") return undefined; throw error; }
    try { fs.writeFileSync(fd, "Physical submission lock. Do not clear while any agent is running.\n"); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    this.syncDirectory();
    return () => { fs.unlinkSync(name); this.syncDirectory(); };
  }
}

/** Per-installation serialized worker. Multiple physical routes, no default fallback. */
export class IppWorker {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly printers: readonly EnrolledPrinter[],
    private readonly journal: IppJournal, private readonly client = new IppClient()) {
    if (new Set(printers.map(p => p.id)).size !== printers.length)
      throw new Error("Duplicate enrolled printer identity");
  }
  process(job: IppJob): Promise<SubmissionEvidence> {
    const snapshot = { ...job, stock: { ...job.stock }, png: Buffer.from(job.png) };
    const pending = this.tail.then(() => this.execute(snapshot));
    this.tail = pending.catch(() => undefined);
    return pending;
  }
  private async execute(job: IppJob): Promise<SubmissionEvidence> {
    const prior = this.journal.read(job);
    if (prior) return prior;
    const printer = this.printers.find(p => p.id === job.printerId);
    if (!printer || printer.kind !== job.kind)
      return { outcome: "failed", reason: "Destination is unknown, removed, or incompatible" };
    const release = this.journal.acquirePrinter(printer.id);
    if (!release) return { outcome: "failed", reason: "Printer is locked by another process or interrupted submission" };
    try {
    let media;
    try { media = await this.client.prepare(printer, job.png, job.stock); }
    catch { return { outcome: "failed", reason: "Printer identity, availability, PNG, or stock validation failed" }; }
    if (!this.journal.begin(job)) return this.journal.read(job)!;
    const evidence = await this.client.submit(printer, job.png, media);
    try { this.journal.finish(job, evidence); }
    catch {
      // The durable sending marker remains: a restarted process must not resend.
      return { outcome: "unknown", reason: "Could not persist printer response; do not resend" };
    }
    return evidence;
    } finally { release(); }
  }
}
