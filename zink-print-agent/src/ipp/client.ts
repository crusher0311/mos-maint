import { createHash } from "node:crypto";
import { Tag, groupValues, type Attributes, type Reply, type Values } from "./codec";
import { selectMedia, type Stock } from "./media";
import { supportedModel, validatePng } from "./validation";
export { supportedModel, validatePng } from "./validation";
import { createExchange, printerUrl, type Exchange } from "./transport";

export interface EnrolledPrinter {
  id: string;
  name: string;
  uri: string;
  uuid: string;
  model: string;
  kind: "sticker" | "keytag";
  stock: Stock;
}
export type SubmissionEvidence =
  | { outcome: "printer-accepted" | "completed"; printerJobId: number }
  | { outcome: "failed" | "unknown"; reason: string; printerJobId?: number };

export function operationAttributes(uri: string): Attributes {
  return {
    "attributes-charset": { tag: Tag.charset, value: "utf-8" },
    "attributes-natural-language": { tag: Tag.language, value: "en" },
    "printer-uri": { tag: Tag.uri, value: uri },
  };
}
function successful(reply: Reply): void {
  if (reply.status !== 0) throw new Error("Printer did not accept attributes exactly");
}
function identity(attrs: Values): { uuid: string; model: string; id: string } {
  const uuid = attrs["printer-uuid"]?.[0], model = attrs["printer-make-and-model"]?.[0];
  if (typeof uuid !== "string" || !/^urn:uuid:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(uuid) ||
      typeof model !== "string" || model.length > 128)
    throw new Error("Printer does not expose a stable UUID and model");
  return { uuid: uuid.toLowerCase(), model,
    id: `ipp-${createHash("sha256").update(uuid.toLowerCase()).digest("hex").slice(0, 32)}` };
}

export class IppClient {
  constructor(private readonly exchange: Exchange = createExchange()) {}

  async inspect(uri: string): Promise<Values> {
    printerUrl(uri);
    const read = async (requested: string[]) => {
      const reply = await this.exchange(uri, 0x0b, [{ tag: 1, values: {
        ...operationAttributes(uri),
        "requested-attributes": requested.map(value => ({ tag: Tag.keyword, value })),
      } }]);
      successful(reply);
      return groupValues(reply, 4);
    };
    const attrs = await read(["printer-uuid", "printer-make-and-model",
      "document-format-supported", "operations-supported", "print-scaling-supported",
      "printer-state", "printer-is-accepting-jobs"]);
    // ZINK may return only media-col-database when requested with other fields.
    const media = await read(["media-col-database"]);
    return { ...attrs, "media-col-database": media["media-col-database"] ?? [] };
  }

  async enroll(uri: string, name: string, kind: EnrolledPrinter["kind"], stock: Stock): Promise<EnrolledPrinter> {
    if (typeof name !== "string" || !name.trim() || name.length > 80 || /[\u0000-\u001f]/.test(name))
      throw new Error("Printer name must contain 1–80 printable characters");
    const attrs = await this.inspect(uri);
    const details = identity(attrs);
    if (!supportedModel(details.model, kind)) throw new Error("Unsupported printer model or label kind");
    selectMedia(attrs, stock, stock);
    return { ...details, uri, name: name.trim(), kind, stock: { ...stock } };
  }

  async prepare(printer: EnrolledPrinter, png: Buffer, requested: Stock): Promise<Attributes> {
    validatePng(png, requested);
    const attrs = await this.inspect(printer.uri);
    const details = identity(attrs);
    if (details.id !== printer.id || details.uuid !== printer.uuid || details.model !== printer.model)
      throw new Error("Printer identity changed; explicit re-enrollment required");
    if (!supportedModel(details.model, printer.kind)) throw new Error("Unsupported printer model");
    if (attrs["printer-is-accepting-jobs"]?.[0] !== true || attrs["printer-state"]?.[0] === 5)
      throw new Error("Enrolled printer is not accepting jobs");
    return selectMedia(attrs, printer.stock, requested).attributes;
  }

  /** Caller MUST persist a sending marker before entering this method. No retry. */
  async submit(printer: EnrolledPrinter, png: Buffer, media: Attributes): Promise<SubmissionEvidence> {
    try {
      const reply = await this.exchange(printer.uri, 2, [
        { tag: 1, values: {
          ...operationAttributes(printer.uri),
          "requesting-user-name": { tag: Tag.name, value: "MOS" },
          "job-name": { tag: Tag.name, value: "MOS label" },
          "document-format": { tag: Tag.mime, value: "image/png" },
          "ipp-attribute-fidelity": { tag: Tag.boolean, value: true },
        } },
        { tag: 2, values: media },
      ], png);
      if (reply.status >= 0x0400) return { outcome: "failed", reason: "Printer rejected the submission" };
      // Even success-with-substitution can mean physical output occurred.
      if (reply.status !== 0 || reply.groups.some(g => g.tag === 5))
        return { outcome: "unknown", reason: "Printer reported substituted or unsupported attributes" };
      const values = groupValues(reply, 2);
      const jobId = values["job-id"]?.[0], state = values["job-state"]?.[0];
      if (typeof jobId !== "number" || !Number.isInteger(jobId) || jobId <= 0)
        return { outcome: "unknown", reason: "Printer response omitted a valid job identity" };
      if (state === 7 || state === 8)
        return { outcome: "failed", printerJobId: jobId, reason: "Printer canceled or aborted the job" };
      return { outcome: state === 9 ? "completed" : "printer-accepted", printerJobId: jobId };
    } catch {
      return { outcome: "unknown", reason: "Printer acceptance response was lost or invalid; do not resend" };
    }
  }

  /** Poll evidence only; never follows a returned job-uri or resubmits content. */
  async status(printer: EnrolledPrinter, printerJobId: number): Promise<SubmissionEvidence> {
    if (!Number.isInteger(printerJobId) || printerJobId <= 0) throw new Error("Invalid printer job ID");
    try {
      // Bind job-id to the enrolled physical identity, including after DHCP changes.
      const attrs = await this.inspect(printer.uri);
      if (identity(attrs).id !== printer.id) throw new Error("Printer identity changed");
      const reply = await this.exchange(printer.uri, 9, [{ tag: 1, values: {
        ...operationAttributes(printer.uri),
        "job-id": { tag: Tag.integer, value: printerJobId },
        "requested-attributes": { tag: Tag.keyword, value: "job-state" },
      } }]);
      successful(reply);
      const state = groupValues(reply, 2)["job-state"]?.[0];
      if (state === 9) return { outcome: "completed", printerJobId };
      if (state === 7 || state === 8)
        return { outcome: "failed", printerJobId, reason: "Printer canceled or aborted the job" };
      if ([3, 4, 5, 6].includes(state as number)) return { outcome: "printer-accepted", printerJobId };
      throw new Error("Missing job state");
    } catch {
      return { outcome: "unknown", printerJobId, reason: "Printer completion could not be established" };
    }
  }
}

