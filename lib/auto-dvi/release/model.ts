import { z } from "zod";
import type { StaffInspection } from "../staff/model";
import { missingRequirements, missingFor, assertPolicyReleaseReady } from "../staff/model";
import { requireThat } from "../../shop-dispatch/model";
import { inspectionMeasurements } from "../staff/measurements";
import {digest} from "../../shop-dispatch/service";

const text = z.string().trim().max(2000);
export const selectedFindingSchema = z.object({
  sheet: z.string().min(1).max(80), item: z.string().min(1).max(80),
  includeInactive: z.boolean(),
  customerText: text.min(1), nextStep: text,
  photoIds: z.array(z.string().regex(/^[a-f0-9]{24}$/)).max(6),
  clipIds: z.array(z.string().regex(/^[a-f0-9]{24}$/)).max(3).optional(),
  concernIds: z.array(z.string().max(100)).max(20),
}).strict();
export const selectionSchema = z.object({
  findings: z.array(selectedFindingSchema).min(1).max(120),
  acknowledgeExcludedHazards: z.boolean(),
}).strict();
export type ReleaseSelection = z.infer<typeof selectionSchema>;
export const brandingSchema = z.object({
  name: z.string().trim().min(1).max(120), phone: z.string().max(40),
  primary: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  // Inline, frozen image bytes only: mutable external logo URLs are not releases.
  logo: z.string().max(180000).regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/).nullable(),
}).strict();
export type ReleaseBranding = z.infer<typeof brandingSchema>;
export interface ReleaseConcern {id: string; words: string}
export interface CustomerFinding {
  key: string; title: string; procedure: string; position: string | null;
  rating: "green" | "yellow" | "red"; customerText: string; nextStep: string;
  measurements: {label: string; value: string | number; unit: string | null}[];
  photoIds: string[]; concernIds: string[];
  clips?: {id: string; caption: string; durationSeconds: number}[];
}
export interface ReleaseClip {
  id: string; caption: string; durationSeconds: number;
  sheet: string; item: string; definitionHash: string; identityDigest: string;
}
export interface CustomerReport {
  schemaVersion: 1; kind: "findings-only"; branding: ReleaseBranding;
  progress: "inspection-in-progress" | "selected-findings";
  concerns: ReleaseConcern[]; findings: CustomerFinding[];
}
export const customerReportSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal("findings-only"), branding: brandingSchema,
  progress: z.enum(["inspection-in-progress", "selected-findings"]),
  concerns: z.array(z.object({id: z.string().max(100), words: z.string().max(2000)}).strict()).max(20),
  findings: z.array(z.object({
    key: z.string().max(170), title: z.string().max(160), procedure: z.string().max(100),
    position: z.string().max(60).nullable(), rating: z.enum(["green", "yellow", "red"]),
    customerText: text.min(1), nextStep: text,
    measurements: z.array(z.object({label: z.string().max(100),
      value: z.union([z.string().max(150), z.number().finite().min(0).max(100000)]),
      unit: z.string().max(30).nullable()}).strict()).max(20),
    photoIds: z.array(z.string().regex(/^[a-f0-9]{24}$/)).max(6),
    clips: z.array(z.object({id: z.string().regex(/^[a-f0-9]{24}$/), caption: text.min(1),
      durationSeconds: z.number().finite().positive().max(15)}).strict()).max(3).optional(),
    concernIds: z.array(z.string().max(100)).max(20),
  }).strict()).min(1).max(120),
}).strict();
export const findingKey = (sheet: string, item: string) => `${sheet}/${item}`;

/**
 * Explicit allow-list, never spread a staff record into the public contract.
 * Customer copy is separately entered/confirmed. Staff notes, NA reasons,
 * actor IDs, audit and upload metadata have no public representation.
 */
export function projectReport(
  inspection: StaffInspection, raw: unknown, concerns: ReleaseConcern[], branding: ReleaseBranding,
  availableClips: ReleaseClip[] = [],
) {
  const selection = selectionSchema.parse(raw);
  assertPolicyReleaseReady(inspection);
  const keys = selection.findings.map(f => findingKey(f.sheet, f.item));
  requireThat(new Set(keys).size === keys.length, "Duplicate selected finding", 400);
  requireThat(new Set(concerns.map(c => c.id)).size === concerns.length, "Ambiguous concern identity", 409);
  const selectedEvidence: unknown[] = [];
  const findings: CustomerFinding[] = selection.findings.map(selected => {
    const sheet = inspection.sheets.find(s => s.key === selected.sheet);
    const item = sheet?.sheet.items.find(i => i.id === selected.item);
    const finding = sheet?.results[selected.item];
    requireThat(sheet && item && finding && finding.rating && finding.rating !== "na", "Select evaluated, non-N/A findings only", 409);
    requireThat(sheet.active || selected.includeInactive, "Explicit inactive-sheet inclusion required", 409);
    if (inspection.policy) requireThat(!missingFor(item, finding).length, "Selected evidence does not satisfy its item requirements", 409);
    requireThat(new Set(selected.photoIds).size === selected.photoIds.length &&
      selected.photoIds.every(id => finding.photos.some(p => p.id === id)), "Select only committed photos on this finding", 409);
    const clips = (selected.clipIds ?? []).map(id => availableClips.find(c => c.id === id &&
      c.sheet === sheet.key && c.item === item.id && c.definitionHash === digest(item)));
    requireThat(new Set(selected.clipIds ?? []).size === (selected.clipIds?.length ?? 0) &&
      clips.every(Boolean), "Select only prepared, caption-reviewed clips for this check", 409);
    requireThat(new Set(selected.concernIds).size === selected.concernIds.length &&
      selected.concernIds.every(id => concerns.some(c => c.id === id)), "Confirm existing concern associations", 409);
    // Include all selected-item evidence, even internal evidence. Editing it
    // requires a new preview, but it never enters the public projection.
    selectedEvidence.push(structuredClone({sheet: sheet.key, active: sheet.active, item, finding}));
    if (clips.length) selectedEvidence.push(structuredClone({clips}));
    return {
      key: findingKey(sheet.key, item.id), title: item.name, procedure: item.procedure,
      position: item.position ?? null, rating: finding.rating as CustomerFinding["rating"],
      customerText: selected.customerText, nextStep: selected.nextStep,
      measurements: inspectionMeasurements(item, finding),
      photoIds: [...selected.photoIds], concernIds: [...selected.concernIds],
      ...(clips.length ? {clips: clips.map(clip => ({id: clip!.id, caption: clip!.caption, durationSeconds: clip!.durationSeconds}))} : {}),
    };
  });
  const excludedHazards = inspection.sheets.flatMap(s => s.sheet.items
    .filter(i => s.results[i.id]?.rating === "red" && !keys.includes(findingKey(s.key, i.id)))
    .map(i => ({key: findingKey(s.key, i.id), title: i.name})));
  // No title-based deduplication: different procedures remain distinct.
  findings.sort((a, b) => Number(!!b.concernIds.length) - Number(!!a.concernIds.length));
  const associated = new Set(findings.flatMap(f => f.concernIds));
  const report: CustomerReport = {
    schemaVersion: 1, kind: "findings-only", branding: brandingSchema.parse(branding),
    progress: missingRequirements(inspection).length ? "inspection-in-progress" : "selected-findings",
    concerns: concerns.filter(c => associated.has(c.id)).map(c => ({id: c.id, words: c.words})), findings,
  };
  return {report, selectedEvidence, excludedHazards, selection};
}
