import fs from "node:fs";
import path from "node:path";
import { IppClient, supportedModel, type EnrolledPrinter } from "./client";
import { validateStock, type Stock } from "./media";
import { printerUrl } from "./transport";

/**
 * Local administrator-controlled physical destinations. No cloud-supplied URI.
 * Never imports tokens or credentials from the reference ZIP.
 */
export class EnrollmentStore {
  constructor(private readonly filename: string) {}
  list(): EnrolledPrinter[] {
    let text: string;
    try {
      if (fs.statSync(this.filename).size > 64 * 1024) throw new Error("Enrollment file too large");
      text = fs.readFileSync(this.filename, "utf8");
    } catch (error: any) { if (error.code === "ENOENT") return []; throw error; }
    const parsed = JSON.parse(text);
    if (parsed.version !== 1 || !Array.isArray(parsed.printers) || parsed.printers.length > 32)
      throw new Error("Invalid enrollment file");
    const ids = new Set<string>();
    for (const p of parsed.printers) {
      if (!p || typeof p.id !== "string" || !/^ipp-[a-f0-9]{32}$/.test(p.id) || ids.has(p.id) ||
          typeof p.name !== "string" || !p.name.trim() || p.name.length > 80 ||
          typeof p.uuid !== "string" || typeof p.model !== "string" || !supportedModel(p.model, p.kind))
        throw new Error("Invalid enrolled printer");
      ids.add(p.id); printerUrl(p.uri); validateStock(p.stock);
    }
    return parsed.printers;
  }
  async enroll(input: { uri: string; name: string; kind: EnrolledPrinter["kind"]; stock: Stock },
    client = new IppClient()): Promise<EnrolledPrinter> {
    // Lock BEFORE awaiting network IO to prevent two setup processes losing updates.
    const release = this.lock();
    try {
      const printers = this.list();
      const printer = await client.enroll(input.uri, input.name, input.kind, input.stock);
      const updated = printers.filter(p => p.id !== printer.id);
      if (updated.length >= 32) throw new Error("At most 32 enrolled printers are supported");
      this.save([...updated, printer]);
      return printer;
    } finally { release(); }
  }
  remove(id: string): void {
    const release = this.lock();
    try {
      const printers = this.list();
      if (!printers.some(p => p.id === id)) throw new Error("Unknown enrolled printer");
      this.save(printers.filter(p => p.id !== id));
    } finally { release(); }
  }
  private lock(): () => void {
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    const lock = `${this.filename}.lock`;
    const fd = fs.openSync(lock, "wx", 0o600);
    fs.closeSync(fd);
    return () => fs.unlinkSync(lock);
  }
  private save(printers: EnrolledPrinter[]): void {
    const temp = `${this.filename}.${process.pid}.tmp`;
    const fd = fs.openSync(temp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ version: 1, printers }, null, 2) + "\n");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.filename);
    if (process.platform !== "win32") {
      const dir = fs.openSync(path.dirname(this.filename), "r");
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    }
  }
}
