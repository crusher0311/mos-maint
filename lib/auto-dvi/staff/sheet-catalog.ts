import {createHash} from "node:crypto";
import {z} from "zod";
import {requireThat} from "@/lib/shop-dispatch/model";
import {canonical} from "../durable/model";
import {configurationSchema, type StaffConfiguration} from "./configuration";
import {sheetSchema, itemSchema, instanceKey, STAFF_SHEET_TEMPLATES, type StaffItem} from "./model";

const editableSheet = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
  version: z.number().int().nonnegative(),
  name: z.string().trim().min(1).max(100),
  items: z.array(itemSchema).min(1).max(60),
}).strict();
export const catalogRequestSchema = z.object({
  requestId: z.string().uuid(), revision: z.number().int().nonnegative(),
  command: z.discriminatedUnion("type", [
    z.object({type: z.literal("save"), sheet: editableSheet, makeDefault: z.boolean()}).strict(),
    z.object({type: z.literal("default"), sheet: z.string().max(80)}).strict(),
    z.object({type: z.literal("archive"), sheetId: z.string().max(60), archived: z.boolean()}).strict(),
  ]),
}).strict();
export interface CatalogAccess {
  key: string; actor: string; shopId: number;
  scope: "shop" | "enterprise"; scopeLabel: string; canManage: boolean;
}
export interface CatalogStore {
  read(key: string): Promise<StaffConfiguration | null>;
  cas(key: string, before: StaffConfiguration | null, after: StaffConfiguration): Promise<boolean>;
}
export interface CatalogDependencies {access(): Promise<CatalogAccess>; store: CatalogStore}
export function catalogSnapshot(access: CatalogAccess, config: StaffConfiguration | null) {
  return {scope: access.scope, scopeLabel: access.scopeLabel, canManage: access.canManage,
    revision: config?.catalogRevision ?? 0, sheets: config?.sheets ?? [],
    archivedSheetIds: config?.archivedSheetIds ?? [], defaultSheet: config?.defaultSheet ?? "",
    templates: STAFF_SHEET_TEMPLATES, inspectionEnabled: !!config?.enabledShopIds.includes(access.shopId)};
}
const hash = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
// This is the same semantic identity used to reuse findings across sheets.
function identity(item: StaffItem) {return `${item.procedure}|${item.position ?? ""}`;}
function measurements(item: StaffItem) {
  return hash(item.fields.map(f => ({id: f.id, type: f.type, unit: f.unit ?? "", options: f.options ?? []})).sort((a,b) => a.id.localeCompare(b.id)));
}
export async function readCatalog(deps: CatalogDependencies) {
  const access = await deps.access();
  return catalogSnapshot(access, await deps.store.read(access.key));
}
export async function updateCatalog(raw: unknown, deps: CatalogDependencies) {
  const request = catalogRequestSchema.parse(raw), access = await deps.access();
  requireThat(access.canManage, "Only authorized managers can manage inspection sheets", 403);
  const before = await deps.store.read(access.key), digest = hash(request);
  const previous = before?.catalogReceipts?.find(r => r.id === request.requestId);
  if (previous) {
    requireThat(previous.actor === access.actor && previous.digest === digest, "Request ID belongs to another sheet change", 409);
    return catalogSnapshot(access, before);
  }
  requireThat(request.revision === (before?.catalogRevision ?? 0), "Inspection sheets changed. Reload and review before saving; your draft has not been applied.", 409);
  requireThat(before || request.command.type === "save", "Create an inspection sheet first", 409);
  const next: StaffConfiguration = structuredClone(before ?? {
    version: 1, enabledShopIds: [], sheets: [], defaultSheet: "", rules: {}, individual: {},
  });
  const command = request.command;
  if (command.type === "save") {
    const history = next.sheets.filter(s => s.id === command.sheet.id);
    const latest = Math.max(0, ...history.map(s => s.version));
    requireThat(command.sheet.version === latest, "Sheet version changed; reload before saving", 409);
    requireThat(next.sheets.length < 200, "Sheet version limit reached; contact an administrator", 409);
    const sheet = sheetSchema.parse({...command.sheet, version: latest + 1});
    for (const item of sheet.items) {
      requireThat(item.name.trim() && item.procedure.trim(), "Inspection items require a name and procedure identity", 400);
      for (const field of item.fields) {
        requireThat(field.label.trim(), "Measurement fields require a label", 400);
        if (field.type === "select") requireThat(field.options?.length &&
          field.options.every(option => option.trim()) && new Set(field.options).size === field.options.length,
          "Choice fields require unique, nonempty options", 400);
      }
    }
    // Keeping an item identity must not reuse old measurements with new meanings.
    const definitions = [...next.sheets.flatMap(s => s.items), ...sheet.items];
    for (const item of sheet.items) {
      requireThat(!definitions.some(old => identity(old) === identity(item) && measurements(old) !== measurements(item)),
        `Measurement definition changed for ${item.name}. Use a new procedure identity for a different measurement.`, 400);
    }
    next.sheets.push(sheet);
    next.archivedSheetIds = (next.archivedSheetIds ?? []).filter(id => id !== sheet.id);
    if (!before || command.makeDefault || history.some(s => instanceKey(s) === next.defaultSheet))
      next.defaultSheet = instanceKey(sheet);
  } else if (command.type === "default") {
    const sheet = next.sheets.find(s => instanceKey(s) === command.sheet);
    requireThat(sheet && !next.archivedSheetIds?.includes(sheet.id), "Choose an active inspection sheet", 400);
    next.defaultSheet = command.sheet;
  } else {
    requireThat(next.sheets.some(s => s.id === command.sheetId), "Inspection sheet not found", 404);
    const currentDefault = next.sheets.find(s => instanceKey(s) === next.defaultSheet)!;
    requireThat(!command.archived || currentDefault.id !== command.sheetId, "Choose a different default before archiving this sheet", 409);
    const archived = new Set(next.archivedSheetIds ?? []);
    command.archived ? archived.add(command.sheetId) : archived.delete(command.sheetId);
    next.archivedSheetIds = [...archived];
  }
  const activeCount = new Set(next.sheets.filter(s => !next.archivedSheetIds?.includes(s.id)).map(s => s.id)).size;
  requireThat(activeCount <= 20, "A maximum of 20 active inspection sheets is supported", 400);
  next.catalogRevision = request.revision + 1;
  next.catalogReceipts = [...(next.catalogReceipts ?? []), {id: request.requestId, actor: access.actor, digest, revision: next.catalogRevision}].slice(-200);
  const validated = configurationSchema.parse(next);
  requireThat(Buffer.byteLength(JSON.stringify(validated), "utf8") <= 8_000_000,
    "Inspection sheet catalog storage limit reached; contact an administrator", 400);
  const fresh = await deps.access();
  requireThat(fresh.canManage && fresh.key === access.key && fresh.actor === access.actor && fresh.shopId === access.shopId,
    "Sheet-management access changed; reload before saving", 403);
  requireThat(await deps.store.cas(access.key, before, validated), "Configuration changed concurrently. Reload and review your draft.", 409);
  return catalogSnapshot(fresh, validated);
}
