import { z } from "zod";
import { CATALOG, type Field } from "../visit-model";
import { requireThat } from "../../shop-dispatch/model";

const text = z.string().trim().max(2000);
export const fieldSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/), label: z.string().min(1).max(100),
  type: z.enum(["number", "text", "select"]), unit: z.string().max(30).optional(),
  options: z.array(z.string().max(80)).max(30).optional(),
}).strict();
export const itemSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_.-]{1,80}$/), name: z.string().min(1).max(160),
  procedure: z.string().min(1).max(100), position: z.string().max(60).optional(),
  fields: z.array(fieldSchema).max(20), required: z.boolean(),
  requiredFields: z.array(z.string().max(60)).max(20),
  notesRequired: z.boolean(), photoRequired: z.boolean(), recommendationRequired: z.boolean(),
}).strict().superRefine((item, ctx) => {
  if (new Set(item.fields.map(f => f.id)).size !== item.fields.length ||
    item.requiredFields.some(id => !item.fields.some(f => f.id === id)))
    ctx.addIssue({code: "custom", message: "Invalid item field configuration"});
});
export const sheetSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/), version: z.number().int().positive(),
  name: z.string().min(1).max(100), items: z.array(itemSchema).min(1).max(60),
}).strict().superRefine((sheet, ctx) => {
  if (new Set(sheet.items.map(i => i.id)).size !== sheet.items.length)
    ctx.addIssue({code: "custom", message: "Duplicate sheet items"});
});
export type StaffSheet = z.infer<typeof sheetSchema>;
export type StaffItem = StaffSheet["items"][number];
export const photoSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{24}$/), mime: z.enum(["image/jpeg", "image/png", "image/webp"]),
  provenance: z.enum(["camera", "upload"]), actor: z.string(), at: z.string().datetime(),
}).strict();
export const findingSchema = z.object({
  rating: z.enum(["green", "yellow", "red", "na"]).nullable(), notes: text,
  recommendation: text, naReason: text,
  values: z.record(z.string(), z.union([z.string().max(150), z.number().finite().min(0).max(100000)])),
}).strict();
export type FindingInput = z.infer<typeof findingSchema>;
export type Photo = z.infer<typeof photoSchema>;
export const arrivalAssociationSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{24}$/), workOrderId: z.string().uuid(),
  mime: z.enum(["image/jpeg", "image/png", "image/webp"]),
  provenance: z.literal("arrival"), capturedAt: z.string().datetime(),
  actor: z.string(), at: z.string().datetime(),
}).strict();
export type ArrivalAssociation = z.infer<typeof arrivalAssociationSchema>;
export interface Finding extends FindingInput { photos: Photo[]; arrivalPhotos?: ArrivalAssociation[]; actor: string; at: string }
export interface SheetInstance { key: string; sheet: StaffSheet; active: boolean; selection: "default" | "manual"; results: Record<string, Finding> }
export interface StaffInspection {
  version: 1; revision: number; sheets: SheetInstance[]; startedAt: string | null;
  evidenceRevision: number; ready: {revision: number; actor: string; at: string} | null;
  reviewed: {revision: number; actor: string; at: string} | null;
}
export const blankFinding = (): FindingInput => ({rating: null, notes: "", recommendation: "", naReason: "", values: {}});
export const instanceKey = (s: StaffSheet) => `${s.id}@${s.version}`;
export function sameInspectionItem(a: StaffItem, b: StaffItem) {
  const fields = (item: StaffItem) => JSON.stringify(item.fields.map(f => ({
    id: f.id, type: f.type, unit: f.unit ?? "", options: f.options ?? [],
  })).sort((x, y) => x.id.localeCompare(y.id)));
  return a.procedure === b.procedure && (a.position ?? "") === (b.position ?? "") && fields(a) === fields(b);
}
export function initialInspection(sheet: StaffSheet): StaffInspection {
  return {version: 1, revision: 0, sheets: [{key: instanceKey(sheet), sheet: structuredClone(sheet),
    active: true, selection: "default", results: {}}], startedAt: null, evidenceRevision: 0, ready: null, reviewed: null};
}
export function validateFinding(item: StaffItem, input: unknown): FindingInput {
  const r = findingSchema.parse(input);
  for (const [key, value] of Object.entries(r.values)) {
    const field = item.fields.find(f => f.id === key);
    requireThat(field, "Unknown measurement", 400);
    if (value === "") { delete r.values[key]; continue; }
    requireThat(field.type === "number" ? typeof value === "number" : typeof value === "string", "Invalid measurement type", 400);
    requireThat(!field.options || field.options.includes(String(value)), "Invalid measurement choice", 400);
  }
  requireThat(r.rating !== "na" || !!r.naReason, "N/A requires a reason; inaccessible is not N/A", 400);
  return r;
}
export function missingFor(item: StaffItem, r?: Finding): string[] {
  if (r?.rating === "na") return r.naReason ? [] : ["N/A reason"];
  if (!r?.rating) return item.required ? ["Rating"] : [];
  return [
    ...(item.notesRequired && !r.notes ? ["Evaluation notes"] : []),
    ...(item.photoRequired && !r.photos.length ? ["Photo"] : []),
    ...(item.recommendationRequired && !r.recommendation ? ["Recommendation / next step"] : []),
    ...item.requiredFields.filter(k => r.values[k] === undefined || r.values[k] === "").map(k => item.fields.find(f => f.id === k)?.label ?? k),
  ];
}
export function missingRequirements(s: StaffInspection) {
  return s.sheets.filter(x => x.active).flatMap(x => x.sheet.items.flatMap(i =>
    missingFor(i, x.results[i.id]).map(message => ({sheet: x.key, item: i.id, name: i.name, message}))));
}
export const commandSchema = z.discriminatedUnion("type", [
  z.object({type: z.literal("associate-arrival"), sheet: z.string().max(80), item: z.string().max(80),
    mediaId: z.string().regex(/^[a-f0-9]{24}$/)}).strict(),
  z.object({type: z.literal("save"), sheet: z.string().max(80), item: z.string().max(80), finding: findingSchema}).strict(),
  z.object({type: z.literal("select"), sheet: z.string().max(80), keepActive: z.boolean()}).strict(),
  z.object({type: z.literal("active"), sheet: z.string().max(80), active: z.boolean()}).strict(),
  z.object({type: z.literal("ready")}).strict(),
  z.object({type: z.literal("review")}).strict(),
]);
export type StaffCommand = z.infer<typeof commandSchema>;
export function applyStaffCommand(state: StaffInspection, command: Exclude<StaffCommand, {type: "associate-arrival"}>, catalog: StaffSheet[], actor: string, at: string, canReview: boolean): StaffInspection {
  const next = structuredClone(state);
  if (command.type === "ready" || command.type === "review") {
    requireThat(next.startedAt && !missingRequirements(next).length, "Complete the missing inspection requirements first", 409);
    requireThat(command.type !== "review" || canReview, "Advisor review permission required", 403);
    next[command.type === "ready" ? "ready" : "reviewed"] = {revision: next.evidenceRevision, actor, at};
  } else if (command.type === "select") {
    const sheet = catalog.find(s => instanceKey(s) === command.sheet);
    requireThat(sheet, "Select an approved sheet version", 400);
    let instance = next.sheets.find(s => s.key === command.sheet);
    if (!instance) {
      requireThat(next.sheets.length < 20, "Sheet capacity reached", 409);
      instance = {key: command.sheet, sheet: structuredClone(sheet), active: true, selection: "manual", results: {}};
      for (const item of sheet.items) {
        const prior = next.sheets.flatMap(s => s.sheet.items.filter(old => sameInspectionItem(old, item))
          .map(old => s.results[old.id]).filter((finding): finding is Finding => !!finding))
          .sort((a,b) => b.at.localeCompare(a.at))[0];
        if (prior) instance.results[item.id] = structuredClone(prior);
      }
      next.sheets.push(instance);
    }
    if (!command.keepActive) next.sheets.forEach(s => {s.active = false;});
    instance.active = true; instance.selection = "manual"; next.evidenceRevision++;
  } else {
    const instance = next.sheets.find(s => s.key === command.sheet);
    requireThat(instance, "Sheet not found", 404);
    if (command.type === "active") {
      instance.active = command.active; instance.selection = "manual";
      requireThat(next.sheets.some(s => s.active), "Keep at least one sheet active", 400);
    } else {
      requireThat(instance.active, "Activate this sheet before editing", 409);
      const item = instance.sheet.items.find(i => i.id === command.item);
      requireThat(item, "Item not found", 404);
      const value = validateFinding(item, command.finding);
      instance.results[item.id] = {...value, photos: instance.results[item.id]?.photos ?? [],
        ...(instance.results[item.id]?.arrivalPhotos ? {arrivalPhotos: instance.results[item.id].arrivalPhotos} : {}), actor, at};
      for (const other of next.sheets) {
        if (other === instance) continue;
        for (const target of other.sheet.items.filter(candidate => sameInspectionItem(item, candidate))) {
          other.results[target.id] = structuredClone(instance.results[item.id]);
        }
      }
      if (value.rating || value.notes || value.recommendation || Object.keys(value.values).length) next.startedAt ??= at;
    }
    next.evidenceRevision++;
  }
  next.revision++;
  return next;
}
const wheelFields: Field[] = [
  {id: "inner", label: "Inner pad", type: "number"}, {id: "outer", label: "Outer pad", type: "number"},
  {id: "unit", label: "Measured unit", type: "select", options: ["mm", "decimal inches", "32nds"]},
];
/** Candidate templates only. Operators must explicitly approve/provision versions. */
export const STAFF_SHEET_TEMPLATES: StaffSheet[] = [sheetSchema.parse({
  id: "manual-safety", version: 1, name: "Manual vehicle inspection",
  items: [
    ...CATALOG.filter(i => i.id !== "brakes" && i.id !== "battery").map(i => ({
      id: i.id, name: i.name, procedure: `manual-${i.id}`, ...(i.position ? {position: i.position} : {}),
      fields: i.fields, required: true, requiredFields: i.kind === "tire" ? ["unit", "inner", "center", "outer", "beforePsi"] : [],
      notesRequired: true, photoRequired: false, recommendationRequired: false,
    })),
    ...["lf", "rf", "lr", "rr"].map(position => ({
      id: `brake.${position}`, name: `${position.toUpperCase()} brake pads`, procedure: "manual-pad-thickness", position,
      fields: wheelFields, required: true, requiredFields: ["inner", "outer", "unit"],
      notesRequired: true, photoRequired: false, recommendationRequired: false,
    })),
    {id: "battery", name: "Battery test", procedure: "manual-battery-test", fields: [
      {id: "oeRating", label: "OE specified rating (if known)", type: "number"},
      {id: "oeSource", label: "OE specification source", type: "text"},
      {id: "oeStandard", label: "OE standard", type: "text"},
      {id: "installedRating", label: "Confirmed installed label rating", type: "number"},
      {id: "installedStandard", label: "Installed standard", type: "text"},
      {id: "measuredCca", label: "Measured CCA", type: "number", unit: "CCA"},
      {id: "measuredStandard", label: "Measured test standard", type: "text"},
      {id: "loadTest", label: "Manual load-test result", type: "text"},
    ], required: true, requiredFields: ["installedRating", "installedStandard", "measuredCca", "measuredStandard", "loadTest"],
    notesRequired: true, photoRequired: false, recommendationRequired: false},
  ],
})];
