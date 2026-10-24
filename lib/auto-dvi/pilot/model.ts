import { z } from "zod";
import { inspectionMeasurements } from "../staff/measurements";
import { createHash, randomUUID } from "node:crypto";
import { canonical } from "../durable/model";
import { requireThat } from "../../shop-dispatch/model";
import type { StaffInspection } from "../staff/model";

export const PILOT_SHOP = 66;
// Legacy fixture remains the default until an operator opts this test instance in.
export const SYNTHETIC_CONTACT = "027fd019-e180-4fa6-98ac-4f551989966f";
export const SYNTHETIC_VEHICLE = "5d837301-83ab-4bc3-ae52-44485e3af1e0";
export const SYNTHETIC_VIN = "1M8GDM9AXKP042788";
export const riskNotice = "CAR Experts test instance: provider concurrency protection and timeout termination are unverified. Do not edit this order in Protractor while sending. An uncertain send is never automatically repeated.";
export const targetScopeSchema = z.enum(["synthetic_fixture", "shop_test_instance"]);
export type PilotTargetScope = z.infer<typeof targetScopeSchema>;
export const pilotConfigurationSchema = z.object({
  admissions: z.boolean(),
  targetScope: targetScopeSchema.optional(),
  connectionHash: z.string().regex(/^[a-f0-9]{64}$/),
  labels: z.object({green: z.string().min(1).max(100), yellow: z.string().min(1).max(100), red: z.string().min(1).max(100)}).strict(),
  labelEvidence: z.enum(["synthetic_roundtrip_only", "shop_configuration"]),
}).strict();
export type PilotConfiguration = z.infer<typeof pilotConfigurationSchema>;
export const connectionHash = (connection: string) => createHash("sha256").update(connection).digest("hex");
const selection = z.object({sheet: z.string().max(80), item: z.string().max(80)}).strict();
export const pilotRequestSchema = z.discriminatedUnion("action", [
  z.object({action: z.literal("preview"), visitId: z.string().min(1).max(100), requestId: z.string().uuid(),
    evidenceRevision: z.number().int().nonnegative(), selected: z.array(selection).min(1).max(100)}).strict(),
  z.object({action: z.literal("send"), visitId: z.string().min(1).max(100), previewId: z.string().uuid(), confirmed: z.literal(true)}).strict(),
  z.object({action: z.literal("reconcile"), visitId: z.string().min(1).max(100)}).strict(),
]);
export const pilotOperationSchema = z.object({
  targetScope: targetScopeSchema.optional(),
  id: z.string().uuid(), actor: z.string(), visitId: z.string(), guid: z.string().uuid(), connectionHash: z.string(),
  requestHash: z.string(), evidenceRevision: z.number().int().nonnegative(),
  evidenceHash: z.string(), policyHash: z.string(), createdAt: z.string().datetime(),
  selected: z.array(selection), lines: z.array(z.object({key: z.string(), title: z.string(), result: z.string(), notes: z.string()}).strict()),
  baseline: z.record(z.string(), z.any()), payload: z.record(z.string(), z.any()),
  state: z.enum(["preview", "admitted", "pending", "partial", "conflict", "confirmed"]),
  acknowledged: z.boolean(), observedAt: z.string().datetime().nullable(),
  confirmedAt: z.string().datetime().nullable(),
}).strict();
export type PilotOperation = z.infer<typeof pilotOperationSchema>;

export function project(inspection: StaffInspection, selected: {sheet: string; item: string}[], labels: PilotConfiguration["labels"]) {
  const seen = new Set<string>();
  return selected.map(({sheet, item}) => {
    const key = `${sheet}/${item}`;
    requireThat(!seen.has(key), "Duplicate finding selection", 400); seen.add(key);
    const instance = inspection.sheets.find(s => s.key === sheet);
    const definition = instance?.sheet.items.find(i => i.id === item), finding = instance?.results[item];
    requireThat(instance?.active && definition && finding?.rating && finding.rating !== "na", "Select an evaluated finding from an active sheet", 409);
    const measurements = inspectionMeasurements(definition, finding)
      .map(f => `${f.label}: ${f.value}${f.unit ? ` ${f.unit}` : ""}`);
    return {key, title: `${instance.sheet.name} — ${definition.name}`,
      result: labels[finding.rating], notes: [finding.notes, ...measurements,
        finding.recommendation ? `Next step (not repair authorization): ${finding.recommendation}` : ""].filter(Boolean).join("\n")};
  });
}
export function inspectionPayload(lines: PilotOperation["lines"]) {
  return {ItemCollection: [{ID: randomUUID(), Chapter: "Inspection",
    ServicePackageHeader: {Title: "MOS vehicle inspection", Description: "Inspection findings only; no priced work or repair authorization."},
    ServicePackageInspectionLines: {ItemCollection: lines.map((line, index) => ({
      ID: randomUUID(), Rank: index + 1, Type: "Line", Title: line.title, Result: line.result, Notes: line.notes,
    }))}}]};
}
export function checkOrder(raw: any, guid: string, scope: PilotTargetScope = "synthetic_fixture") {
  requireThat(raw?.ID?.toLowerCase() === guid &&
    z.string().uuid().safeParse(raw.Contact?.ID).success &&
    z.string().uuid().safeParse(raw.ServiceItem?.ID).success,
  "Exact order/customer/vehicle identity could not be verified", 409);
  if (scope === "synthetic_fixture") requireThat(raw.Contact.ID.toLowerCase() === SYNTHETIC_CONTACT &&
    raw.ServiceItem.ID.toLowerCase() === SYNTHETIC_VEHICLE && raw.ServiceItem.VIN?.toUpperCase() === SYNTHETIC_VIN,
    "Exact synthetic order/customer/vehicle identity could not be verified", 409);
  requireThat(raw.Type === "WorkOrder" && raw.Completed === false, "Open work order required", 409);
  const packages = raw.ServicePackages?.ItemCollection;
  requireThat(Array.isArray(packages), "Complete nested provider packages required", 409);
  const ids = new Set<string>();
  for (const pkg of packages) {
    requireThat(["Service", "Inspection", "Concern"].includes(pkg.Chapter), "Unsupported provider package", 409);
    if (pkg.Chapter === "Concern") requireThat(typeof pkg.ServicePackageHeader?.Title === "string" &&
      typeof pkg.ServicePackageHeader?.Description === "string", "Malformed concern package", 409);
    const lines = pkg.Chapter === "Inspection" ? pkg.ServicePackageInspectionLines?.ItemCollection : pkg.ServicePackageLines?.ItemCollection;
    requireThat(Array.isArray(lines), "Provider omitted a nested line collection", 409);
    for (const node of [pkg, ...lines]) {
      requireThat(typeof node.ID === "string" && !ids.has(node.ID.toLowerCase()), "Ambiguous provider identities", 409);
      ids.add(node.ID.toLowerCase());
    }
  }
  return raw as Record<string, any>;
}
/** Preserve all baseline packages, including their unknown fields. HTTP success
 * is not proof. Unknown/provider-added variants deliberately do not normalize. */
export function classifyPilot(op: PilotOperation, raw: any): PilotOperation["state"] {
  try {
    checkOrder(raw, op.guid, op.targetScope);
    const bytes = canonical(raw);
    if (bytes === canonical(op.baseline)) return "pending";
    const expected = structuredClone(op.baseline);
    const added = structuredClone(op.payload.ItemCollection[0]);
    expected.ServicePackages.ItemCollection.push(added);
    if (bytes === canonical(expected)) return "confirmed";
    const found = raw.ServicePackages.ItemCollection.find((p: any) => p.ID === added.ID);
    const lines = found?.ServicePackageInspectionLines?.ItemCollection;
    const intended = added.ServicePackageInspectionLines.ItemCollection;
    if (!Array.isArray(lines) || lines.length >= intended.length) return "conflict";
    // Partial means only missing intended lines, never unexpected fields,
    // changed ordering, priced collections or malformed package containers.
    added.ServicePackageInspectionLines.ItemCollection = intended.filter((line: any) =>
      lines.some((observed: any) => observed.ID === line.ID));
    return bytes === canonical(expected) ? "partial" : "conflict";
  } catch { return "conflict"; }
}
