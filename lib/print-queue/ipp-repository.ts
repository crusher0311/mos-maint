import { createHash, randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { ippStoreDeps, updateIppInventory, listIppInventories, readIppDefaults,
  updateIppDefaults, findIppJob, updateIppJob, claimIppJob } from "@/lib/data/repositories/ipp-print-store";
import { validatePng, supportedModel } from "@/zink-print-agent/src/ipp/validation";
import { validateStock } from "@/zink-print-agent/src/ipp/media";
import { MAX_PRINT_IMAGE_INPUT_CHARS } from "./types";
import { IPP_PROTOCOL, type LabelKind, type PrintStock, type SavedDestination, type IppStatus, type IppWireJob } from "./ipp-contract";

export const __ippDeps = ippStoreDeps;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const oid = (value: unknown) => new ObjectId(digest(value).slice(0, 24));
const ONLINE_MS = 120000;
export class IppRequestError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}
export function labelKind(value: unknown): LabelKind {
  if (value !== "sticker" && value !== "keytag") throw new IppRequestError("Choose sticker or keytag");
  return value;
}
export function agentIdentity(shopId: number, keyHash: string, installationId: unknown): string {
  if (typeof installationId !== "string" || !/^[a-zA-Z0-9_-]{8,64}$/.test(installationId))
    throw new IppRequestError("Invalid installation identity");
  return digest([shopId, keyHash, installationId]);
}
export interface InventoryPrinter {
  id: string; name: string; model: string; kind: LabelKind; stock: PrintStock; online: boolean;
}
export function inventoryRevision(p: InventoryPrinter): string {
  return digest([p.id, p.kind, p.stock.width, p.stock.height, p.model]);
}
export function validateInventory(raw: unknown): InventoryPrinter[] {
  if (!Array.isArray(raw) || raw.length > 32) throw new IppRequestError("Invalid enrolled printer inventory");
  const ids = new Set<string>();
  return raw.map(p => {
    if (!p || typeof p.id !== "string" || !/^ipp-[a-f0-9]{32}$/.test(p.id) || ids.has(p.id) ||
        typeof p.name !== "string" || !p.name.trim() || p.name.length > 80 || /[\u0000-\u001f]/.test(p.name) ||
        typeof p.model !== "string" || p.model.length > 128 || typeof p.online !== "boolean")
      throw new IppRequestError("Invalid enrolled printer identity");
    const kind = labelKind(p.kind);
    try { validateStock(p.stock); } catch { throw new IppRequestError("Invalid loaded stock"); }
    ids.add(p.id);
    // Deliberately project away LAN URIs, arbitrary attributes, and credentials.
    return { id: p.id, name: p.name.trim(), model: p.model, kind,
      stock: { width: p.stock.width, height: p.stock.height }, online: p.online };
  });
}
export async function publishInventory(shopId: number, agentId: string, raw: unknown) {
  const printers = validateInventory(raw);
  await updateIppInventory({ _id: oid([shopId, agentId]), shopId, agentId }, {
    $set: { shopId, agentId, protocol: IPP_PROTOCOL, printers, seenAt: new Date() },
  });
}
export async function destinations(shopId: number, kind: LabelKind): Promise<SavedDestination[]> {
  const inventories = await listIppInventories(shopId, IPP_PROTOCOL);
  return inventories.flatMap(agent => (agent.printers as InventoryPrinter[]).filter(p => p.kind === kind).map(p => ({
    id: digest([agent.agentId, p.id]), agentId: agent.agentId, printerId: p.id,
    name: p.name, model: p.model, kind: p.kind, stock: p.stock, revision: inventoryRevision(p),
    supported: supportedModel(p.model, p.kind),
    online: p.online && Date.now() - new Date(agent.seenAt).getTime() < ONLINE_MS,
  })));
}
export async function getDestinationSettings(shopId: number, kind: LabelKind, canManage: boolean) {
  const [list, defaults] = await Promise.all([destinations(shopId, kind),
    readIppDefaults({ _id: oid([shopId, kind]), shopId, kind })]);
  return { shopId, kind, destinations: list, defaultDestinationId: defaults?.destinationId ?? null, canManage };
}
export async function setDefaultDestination(shopId: number, kind: LabelKind, destinationId: unknown) {
  if (destinationId !== null) {
    if (typeof destinationId !== "string") throw new IppRequestError("Invalid destination");
    const selected = (await destinations(shopId, kind)).find(p => p.id === destinationId);
    if (!selected || !selected.supported) throw new IppRequestError("Destination is removed or unsupported", 409);
  }
  await updateIppDefaults({ _id: oid([shopId, kind]), shopId, kind }, {
    $set: { shopId, kind, destinationId, updatedAt: new Date() },
  });
}
export function pngBytes(value: unknown, stock: PrintStock): Buffer {
  if (typeof value !== "string" || value.length > MAX_PRINT_IMAGE_INPUT_CHARS)
    throw new IppRequestError("PNG exceeds size limit", 413);
  const raw = value.replace(/^data:image\/png;base64,/, "");
  if (!raw || raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw))
    throw new IppRequestError("Expected base64 PNG");
  const bytes = Buffer.from(raw, "base64");
  try { validatePng(bytes, stock); } catch (err: any) { throw new IppRequestError(err.message); }
  return bytes;
}
export async function enqueueIpp(shopId: number, input: any) {
  const kind = labelKind(input.type);
  if (typeof input.printActionId !== "string" ||
      !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.printActionId))
    throw new IppRequestError("A stable print action UUID is required");
  const image = pngBytes(input.imageBase64, input.stock);
  if (typeof input.destinationId !== "string" || typeof input.revision !== "string")
    throw new IppRequestError("Choose a saved printer and stock");
  const fingerprint = digest([input.destinationId, input.revision, kind,
    input.stock.width, input.stock.height, image.toString("base64")]);
  const _id = oid(["ipp", shopId, input.printActionId]);
  const existing = await findIppJob({ _id, shopId, protocol: IPP_PROTOCOL });
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw new IppRequestError("Print action already belongs to different content or destination", 409);
    return { success: true, jobId: String(_id), status: existing.status };
  }
  const selected = (await destinations(shopId, kind)).find(p => p.id === input.destinationId);
  if (!selected || !selected.supported || !selected.online)
    throw new IppRequestError("Selected printer is removed, offline or unsupported; no fallback was used", 409);
  if (selected.revision !== input.revision || selected.stock.width !== input.stock.width || selected.stock.height !== input.stock.height)
    throw new IppRequestError("Label dimensions or loaded stock changed; correct the selection explicitly", 409);
  const now = new Date();
  try {
    await updateIppJob({ _id, shopId }, { $setOnInsert: {
      shopId, protocol: IPP_PROTOCOL, status: "queued", kind, agentId: selected.agentId,
      printerId: selected.printerId, destinationId: selected.id, revision: selected.revision,
      stock: selected.stock, imageBase64: image.toString("base64"), fingerprint,
      createdAt: now, updatedAt: now, attempts: 0,
      // No customer fields or label content in operational logs.
    } }, { upsert: true });
  } catch (err: any) { if (err.code !== 11000) throw err; }
  const saved = await findIppJob({ _id, shopId, protocol: IPP_PROTOCOL });
  if (!saved || saved.fingerprint !== fingerprint) throw new IppRequestError("Print action conflict", 409);
  return { success: true, jobId: String(_id), status: saved.status };
}
function wire(doc: any, reconcileOnly: boolean): IppWireJob & { reconcileOnly: boolean } {
  return { protocol: IPP_PROTOCOL, id: String(doc._id), claimToken: doc.claimToken,
    printerId: doc.printerId, kind: doc.kind, stock: doc.stock, revision: doc.revision,
    imageBase64: doc.imageBase64, reconcileOnly };
}
export async function pollIpp(shopId: number, agentId: string) {
  const scope = { shopId, agentId, protocol: IPP_PROTOCOL };
  // A delivered claim is never reset or granted a new fence, even after months.
  const unresolved = await findIppJob({ ...scope, status: "claimed" }, { sort: { createdAt: 1 } });
  if (unresolved) return wire(unresolved, true);
  const claimed = await claimIppJob({ ...scope, status: "queued" },
    { $set: { status: "claimed", claimToken: randomUUID(), claimedAt: new Date(), updatedAt: new Date() },
      $inc: { attempts: 1 } });
  const doc = claimed && ("value" in claimed ? claimed.value : claimed);
  if (doc) return wire(doc, false);
  const accepted = await findIppJob({ ...scope, status: "printer-accepted" }, { sort: { updatedAt: 1 } });
  return accepted ? wire(accepted, true) : null;
}
export async function ackIpp(shopId: number, agentId: string, input: any) {
  if (typeof input.jobId !== "string" || !/^[a-f0-9]{24}$/i.test(input.jobId) ||
      typeof input.claimToken !== "string" || !["printer-accepted", "completed", "failed", "unknown"].includes(input.status))
    throw new IppRequestError("Invalid IPP acknowledgment");
  if (["printer-accepted", "completed"].includes(input.status) &&
      (!Number.isInteger(input.printerJobId) || input.printerJobId <= 0))
    throw new IppRequestError("Printer evidence is required");
  const scope = { _id: new ObjectId(input.jobId), shopId, agentId, protocol: IPP_PROTOCOL, claimToken: input.claimToken };
  const doc = await findIppJob(scope);
  if (!doc) throw new IppRequestError("Claim not found", 404);
  if (doc.status === "completed" || doc.status === "failed") return { ok: true };
  if (doc.printerJobId && input.printerJobId && doc.printerJobId !== input.printerJobId)
    throw new IppRequestError("Printer job identity conflict", 409);
  // Never downgrade recorded acceptance solely because later status polling failed.
  const status = doc.status === "printer-accepted" && input.status === "unknown" ? doc.status : input.status;
  await updateIppJob({ ...scope, status: doc.status }, { $set: {
    status, updatedAt: new Date(),
    ...(Number.isInteger(input.printerJobId) ? { printerJobId: input.printerJobId } : {}),
    error: status === "unknown" ? "Outcome unknown; inspect printer before any new print" :
      status === "failed" ? "Printer or preflight rejected the print; inspect printer before any new print" : null,
  } });
  return { ok: true };
}
export async function getIppStatus(shopId: number, jobId: string, kind?: LabelKind) {
  if (!/^[a-f0-9]{24}$/i.test(jobId)) throw new IppRequestError("Job not found", 404);
  const doc = await findIppJob({ _id: new ObjectId(jobId), shopId, protocol: IPP_PROTOCOL, ...(kind ? { kind } : {}) },
    { projection: { status: 1, destinationId: 1, error: 1, kind: 1, claimedAt: 1 } });
  if (!doc) throw new IppRequestError("Job not found", 404);
  // Display uncertainty without resetting claim authority or sending work again.
  const status: IppStatus = doc.status === "claimed" && Date.now() - new Date(doc.claimedAt).getTime() > 120000
    ? "unknown" : doc.status;
  return { jobId, status, destinationId: doc.destinationId, error: doc.error ?? undefined, kind: doc.kind };
}
