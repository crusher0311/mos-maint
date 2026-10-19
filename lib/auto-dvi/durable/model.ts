import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const VERSION = 1;
export const stages = ["packages", "findings"] as const;
export type Stage = typeof stages[number];
export type StageState = "prepared" | "admitted" | "acknowledged" | "verified" | "uncertain" | "conflict" | "not_requested";
export type Classification = "desired" | "baseline" | "partial_or_edited" | "unknown";
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as any)[k])}`).join(",")}}`;
  }
  throw new DurableError("INVALID_REQUEST", 400);
}
export const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export class DurableError extends Error {
  constructor(public code: string, public status = 409) { super(code); }
}
const text = z.string().max(10000);
const optionalText = text.nullable().optional().transform(v => v ?? null);
const item = z.object({
  name: z.string().min(1).max(500).refine(v => !!v.trim()),
  serviceKey: optionalText, rating: z.enum(["green", "yellow", "red"]).nullable().optional().transform(v => v ?? null),
  notes: optionalText, recommendation: optionalText,
  source: z.enum(["vhi", "shop", "recall"]).optional().default("vhi"),
  bucket: z.enum(["overdue", "due_soon", "upcoming"]).nullable().optional().transform(v => v ?? null),
  action: optionalText, dueAtMiles: z.number().finite().nullable().optional().transform(v => v ?? null),
  milesToGo: z.number().finite().nullable().optional().transform(v => v ?? null), itemNotes: optionalText,
}).strict();
const requestSchema = z.object({
  clientRequestId: z.string().min(8).max(128).regex(/^[a-zA-Z0-9_-]+$/),
  workOrderGuid: z.string().uuid().transform(v => v.toLowerCase()),
  vin: z.string().regex(/^[a-hj-npr-z0-9]{17}$/i).transform(v => v.toUpperCase()),
  roNumber: z.string().max(80).nullable().optional().transform(v => v ?? null),
  items: z.array(item).min(1).max(100),
  recommendedItems: z.array(z.object({ name: z.string().min(1).max(500).refine(v => !!v.trim()), serviceKey: optionalText }).strict()).max(100).optional().default([]),
}).strict();
export type Request = Omit<z.infer<typeof requestSchema>, "clientRequestId">;
export function parseRequest(body: unknown) {
  const result = requestSchema.safeParse(body);
  if (!result.success) throw new DurableError("INVALID_REQUEST", 400);
  const { clientRequestId, ...request } = result.data;
  return { clientRequestId, request };
}
export interface Scope { shopId: number; actor: string }
export interface Target { shopId: number; connection: string; connectionVersion: string; guid: string; vin: string }
export interface Snapshot {
  target: Target; open: boolean; fresh: boolean; complete: boolean;
  revision: string; body: Record<string, any>;
}
export interface Plan {
  version: number; target: Target; baseline: Snapshot;
  payloads: Record<Stage, Record<string, any> | null>;
  /** Full replacement projections, including unrelated packages. */
  desired: Record<Stage, Record<string, any>>;
  itemKeys: string[]; lineCount: number; recommendedCount: number;
}
export interface StageRecord {
  /** Only an affirmative completed transport or independently verified
   * quiescence proves an older attempt cannot execute again. */
  transportSettled?: boolean;
  verifiedRevision?: string;
  state: StageState; revision: number; token: string | null; admittedAt: string | null;
  transport: "REST"; payloadHash: string; classification: Classification | null;
  observedHash: string | null; observedRevision: string | null; error: string | null;
}
export interface Operation {
  id: string; schemaVersion: number; comparatorVersion: number; composerVersion: number;
  scope: Scope; key: string; request: Request; requestDigest: string; requestBytes: string;
  plan: Plan; planDigest: string; planBytes: string;
  state: "prepared" | "in_progress" | "verification_required" | "conflict" | "provider_verified" | "complete";
  revision: number; stages: Record<Stage, StageRecord>; createdAt: string;
  claim: { token: string; until: number } | null;
}
export interface Reply { status: number; body: Record<string, any> }
export function pending(op: Operation): Reply {
  return { status: op.state === "conflict" ? 409 : 202, body: {
    ok: false, operationId: op.id, operationState: op.state, workOrderId: op.plan.target.guid,
    readBackStatus: op.state === "conflict" ? "conflict" : "unavailable",
    inspectionResultsWritten: op.stages.findings.state === "verified", recoveryAllowed: false,
    nextAction: "reconcile", packageStatus: op.stages.packages.state,
    resultsStatus: op.stages.findings.state, localReceiptStatus: "unconfirmed",
    outcome: "uncertain",
    message: "Verification is required. Do not resend the inspection or create a replacement request.",
  }};
}
export function newOperation(scope: Scope, key: string, request: Request, plan: Plan): Operation {
  const stage = (name: Stage): StageRecord => ({
    state: plan.payloads[name] ? "prepared" : "not_requested", revision: 0, token: null,
    admittedAt: null, transport: "REST", payloadHash: digest(plan.payloads[name]),
    classification: null, observedHash: null, observedRevision: null, error: null,
  });
  return {
    id: randomUUID(), schemaVersion: VERSION, comparatorVersion: VERSION, composerVersion: VERSION,
    scope, key, request, requestDigest: digest(request), requestBytes: canonical(request),
    plan, planDigest: digest(plan), planBytes: canonical(plan), state: "prepared", revision: 0,
    stages: { packages: stage("packages"), findings: stage("findings") },
    createdAt: new Date().toISOString(), claim: null,
  };
}

/** Strict v1: no undocumented normalization or assumed deletion semantics. */
export function validSnapshot(s: Snapshot, target: Target): boolean {
  if (!s || !s.fresh || !s.complete || !s.open || !s.revision || canonical(s.target) !== canonical(target)) return false;
  const packages = s.body?.ServicePackages?.ItemCollection;
  if (s.body?.ID !== target.guid || !Array.isArray(packages)) return false;
  const ids = new Set<string>([target.guid]);
  for (const pkg of packages) {
    if (!pkg || typeof pkg.ID !== "string" || ids.has(pkg.ID)) return false;
    ids.add(pkg.ID);
    const lines = pkg.Chapter === "Inspection" ? pkg.ServicePackageInspectionLines : pkg.ServicePackageLines;
    if (!Array.isArray(lines?.ItemCollection)) return false;
    for (const line of lines.ItemCollection) {
      if (!line || typeof line.ID !== "string" || ids.has(line.ID)) return false;
      ids.add(line.ID);
    }
  }
  return true;
}
export function classify(plan: Plan, stage: Stage, observed: Snapshot): Classification {
  // Duplicate identities are positive conflict evidence, not absence. Missing
  // collections are still unknown. No deletion normalization is approved in v1.
  if (observed?.fresh && observed.complete && canonical(observed.target) === canonical(plan.target)) {
    const seen = new Set<string>();
    const packages = observed.body?.ServicePackages?.ItemCollection;
    for (const pkg of Array.isArray(packages) ? packages : []) {
      const lines = pkg?.Chapter === "Inspection" ? pkg.ServicePackageInspectionLines : pkg?.ServicePackageLines;
      for (const node of [pkg, ...(Array.isArray(lines?.ItemCollection) ? lines.ItemCollection : [])]) {
        if (typeof node?.ID === "string") {
          if (seen.has(node.ID)) return "partial_or_edited";
          seen.add(node.ID);
        }
      }
    }
  }
  if (!validSnapshot(observed, plan.target)) return "unknown";
  const bytes = canonical(observed.body);
  if (bytes === canonical(plan.desired[stage]) ||
      (stage === "packages" && bytes === canonical(plan.desired.findings))) return "desired";
  const baseline = stage === "packages" ? plan.baseline.body : plan.desired.packages;
  if (bytes === canonical(baseline) || bytes === canonical(plan.baseline.body)) return "baseline";
  return "partial_or_edited";
}
