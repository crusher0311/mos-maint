import { z } from "zod";
import type { BindingAdmission, WorkflowInspection, WorkflowInspectionRepository } from "../workflow-binding-contract";
import { applyBindingAdmission } from "../workflow-binding-state";
import { digest } from "../../shop-dispatch/service";
import { requireThat } from "../../shop-dispatch/model";
import { applyStaffCommand, initialInspection, instanceKey, photoSchema, sheetSchema, findingSchema,
  type Photo, type StaffCommand, type StaffInspection, type StaffSheet } from "./model";

const identitySchema = z.object({version: z.literal(1), shopId: z.number().int().positive(), workflowVisitId: z.string().min(1),
  provider: z.enum(["manual", "protractor"]), providerWorkOrderId: z.string().uuid().nullable()}).strict();
const admissionSchema = z.object({version: z.literal(1), requestId: z.string().uuid(), digest: z.string().length(64),
  actorId: z.string().min(1), identity: identitySchema, aliases: z.array(z.string()).max(500),
  expectedBoardRevision: z.number().int().nonnegative(), admittedBoardRevision: z.number().int().positive(),
  expectedInspectionRevision: z.number().int().nonnegative(), at: z.string().datetime()}).strict();
const revision = z.number().int().nonnegative();
const marker = z.object({revision, actor: z.string(), at: z.string().datetime()}).strict().nullable();
export const staffStateSchema = z.object({
  version: z.literal(1), revision, evidenceRevision: revision, startedAt: z.string().datetime().nullable(), ready: marker, reviewed: marker,
  sheets: z.array(z.object({key: z.string(), sheet: sheetSchema, active: z.boolean(), selection: z.enum(["default", "manual"]),
    results: z.record(z.string(), findingSchema.extend({photos: z.array(photoSchema).max(6), actor: z.string(), at: z.string().datetime()})),
  }).strict()).min(1).max(20),
}).strict();
const bindingSchema = z.object({
  identity: identitySchema, aliases: z.array(z.string()).max(500), revision, closed: z.boolean(),
  results: z.object({staff: staffStateSchema.optional()}).strict(),
  receipts: z.array(admissionSchema.extend({inspectionRevision: revision})).max(5000),
  events: z.array(z.object({version: z.literal(1), id: z.string(), actorId: z.string(), source: z.literal("workflow-intake"),
    at: z.string().datetime(), reason: z.enum(["bind", "ticket-confirmed", "import-alias"]), correlationId: z.string(),
    before: identitySchema.nullable(), after: identitySchema, aliases: z.array(z.string()),
  }).strict()).max(5000),
}).strict();
export interface StaffReceipt {requestId: string; digest: string; actor: string; visitId: string; revision: number}
export interface StaffEvent {requestId: string; actor: string; at: string; visitId: string; before: StaffInspection | null; after: StaffInspection}
const uploadSchema = z.object({requestId: z.string().uuid(), digest: z.string().length(64), actor: z.string(),
  visitId: z.string(), sheet: z.string(), item: z.string(), revision, photo: photoSchema,
  state: z.enum(["reserved", "committed", "abandoned"])}).strict();
export type UploadReservation = z.infer<typeof uploadSchema>;
export interface ShopState {version: 1; revision: number; records: WorkflowInspection[]; receipts: StaffReceipt[]; events: StaffEvent[]; uploads: UploadReservation[]}
export const emptyShopState = (): ShopState => ({version: 1, revision: 0, records: [], receipts: [], events: [], uploads: []});
export function validateShopState(raw: unknown): ShopState {
  return z.object({version: z.literal(1), revision, records: z.array(bindingSchema).max(500), uploads: z.array(uploadSchema).max(5000),
    receipts: z.array(z.object({requestId: z.string().uuid(), digest: z.string().length(64), actor: z.string(), visitId: z.string(), revision}).strict()).max(5000),
    events: z.array(z.object({requestId: z.string().uuid(), actor: z.string(), at: z.string().datetime(), visitId: z.string(),
      before: staffStateSchema.nullable(), after: staffStateSchema}).strict()).max(5000),
  }).strict().parse(raw) as ShopState;
}
/** Single aggregate CAS makes uniqueness + receipts + evidence atomic without
 * relying on indexes that may not have been provisioned. Independent inspection
 * revisions remain the caller's conflict boundary. Bounded, no unbounded retry. */
export interface StaffPersistence {
  read(shopId: number): Promise<ShopState>;
  cas(shopId: number, revision: number, state: ShopState): Promise<boolean>;
}
export class StaffRepository implements WorkflowInspectionRepository {
  constructor(readonly persistence: StaffPersistence) {}
  async read(shopId: number, visitId: string) {
    const state = await this.persistence.read(shopId);
    return structuredClone(state.records.find(r => r.identity.workflowVisitId === visitId || r.aliases.includes(visitId)) ?? null);
  }
  async commit(raw: BindingAdmission): Promise<"confirmed" | "conflict"> {
    const a = admissionSchema.parse(raw), state = await this.persistence.read(a.identity.shopId);
    if (state.uploads.some(u => u.requestId === a.requestId)) return "conflict";
    const prior = state.receipts.find(r => r.requestId === a.requestId);
    if (prior && (prior.actor !== a.actorId || prior.visitId !== a.identity.workflowVisitId)) return "conflict";
    const record = applyBindingAdmission(state.records, a);
    if (!record) return "conflict";
    const existing = state.records.find(r => r.identity.workflowVisitId === a.identity.workflowVisitId);
    if (existing?.receipts.some(r => r.requestId === a.requestId)) return "confirmed";
    if (existing) state.records[state.records.indexOf(existing)] = record;
    else state.records.push(record);
    return await this.save(a.identity.shopId, state) ? "confirmed" : "conflict";
  }
  private async save(shopId: number, state: ShopState) {
    const expected = state.revision;
    state.revision++;
    requireThat(state.records.length <= 500 && state.receipts.length <= 5000 && state.events.length <= 5000 &&
      Buffer.byteLength(JSON.stringify(state)) < 8 * 1024 * 1024, "Inspection retention capacity reached; operator review required", 409);
    validateShopState(state);
    return this.persistence.cas(shopId, expected, state);
  }
  async reservePhoto(shopId: number, raw: UploadReservation, authorize: () => Promise<void>) {
    const requested = uploadSchema.parse(raw);
    await authorize();
    const state = await this.persistence.read(shopId), existing = state.uploads.find(u => u.requestId === requested.requestId);
    if (existing) {
      requireThat(existing.digest === requested.digest && existing.actor === requested.actor &&
        existing.visitId === requested.visitId && existing.state !== "abandoned", "Upload receipt conflicts or was abandoned", 409);
      return existing;
    }
    requireThat(!state.receipts.some(r => r.requestId === requested.requestId) &&
      !state.records.some(r => r.receipts.some(x => x.requestId === requested.requestId)), "Request already used", 409);
    requireThat(state.uploads.filter(u => u.state === "reserved").length < 20, "Pending photo capacity reached; resolve previous uploads first", 409);
    const record = state.records.find(r => r.identity.workflowVisitId === requested.visitId);
    const inspection = record?.results.staff as StaffInspection | undefined;
    requireThat(inspection?.revision === requested.revision, "Inspection changed; compare before uploading", 409);
    const instance = inspection.sheets.find(s => s.key === requested.sheet && s.active);
    const finding = instance?.results[requested.item];
    requireThat(finding && finding.photos.length < 6, "Save the item first; maximum six photos per item", 409);
    state.uploads.push(requested);
    await authorize();
    requireThat(await this.save(shopId, state), "Concurrent photo admission; retry the same upload", 409);
    return requested;
  }
  /** Operator-only bounded orphan reclamation. CAS fences commit before deleting
   * bytes. Receipt/tombstone remains; never delete a committed photo. */
  async abandonPhotos(shopId: number, before: string) {
    const state = await this.persistence.read(shopId);
    const expired = state.uploads.filter(u => u.state === "reserved" && u.photo.at < before).slice(0, 20);
    expired.forEach(u => {u.state = "abandoned";});
    if (expired.length) requireThat(await this.save(shopId, state), "Cleanup conflicted; retry after rereading", 409);
    return expired.map(u => u.photo.id);
  }
  async mutate(input: {
    shopId: number; visitId: string; requestId: string; expectedRevision: number; actor: string; at: string;
    command: StaffCommand | {type: "initialize"} | {type: "photo"; sheet: string; item: string; photo: Photo};
    catalog: StaffSheet[]; defaultSheet: string; canReview: boolean;
    authorize: () => Promise<void>;
  }) {
    const {shopId, visitId, requestId, actor, command} = input;
    z.string().uuid().parse(requestId);
    const hash = digest({visitId, revision: input.expectedRevision, command});
    await input.authorize();
    const state = await this.persistence.read(shopId);
    const receipt = state.receipts.find(r => r.requestId === requestId);
    requireThat(command.type === "initialize" || !state.records.some(r => r.receipts.some(x => x.requestId === requestId)), "Request ID reserved for binding", 409);
    if (receipt) {
      requireThat(receipt.actor === actor && receipt.digest === hash && receipt.visitId === visitId, "Request ID conflicts with saved work", 409);
      await input.authorize();
      return receipt;
    }
    const record = state.records.find(r => r.identity.workflowVisitId === visitId);
    requireThat(record && !record.closed, "Canonical inspection binding required", 409);
    const current = record.results.staff as StaffInspection | undefined;
    requireThat((current?.revision ?? 0) === input.expectedRevision, "Another contributor changed this inspection. Compare and reload.", 409);
    let next: StaffInspection;
    if (command.type === "initialize") {
      requireThat(!current, "Inspection already initialized", 409);
      const sheet = input.catalog.find(s => instanceKey(s) === input.defaultSheet);
      requireThat(sheet, "Approved default sheet unavailable", 409);
      next = initialInspection(sheet);
      next.revision = 1;
    } else {
      requireThat(current, "Initialize the approved inspection first", 409);
      if (command.type === "photo") {
        const reservation = state.uploads.find(u => u.requestId === requestId);
        requireThat(reservation?.state === "reserved" && reservation.actor === actor &&
          reservation.visitId === visitId && reservation.sheet === command.sheet && reservation.item === command.item &&
          digest(reservation.photo) === digest(command.photo), "Exact upload reservation required", 409);
        next = structuredClone(current);
        const sheet = next.sheets.find(s => s.key === command.sheet && s.active);
        const finding = sheet?.results[command.item];
        requireThat(sheet && finding && sheet.sheet.items.some(i => i.id === command.item), "Save an item result before attaching evidence", 409);
        requireThat(finding.photos.length < 6, "Six photos per item maximum", 409);
        requireThat(next.sheets.flatMap(s => Object.values(s.results)).reduce((n, r) => n + r.photos.length, 0) < 60, "Sixty photos per visit maximum", 409);
        finding.photos.push(photoSchema.parse(command.photo));
        reservation.state = "committed";
        next.startedAt ??= input.at; next.revision++; next.evidenceRevision++;
      } else next = applyStaffCommand(current, command, input.catalog, actor, input.at, input.canReview);
    }
    record.results.staff = next; record.revision++;
    const saved: StaffReceipt = {requestId, digest: hash, actor, visitId, revision: next.revision};
    state.receipts.push(saved);
    state.events.push({requestId, actor, at: input.at, visitId, before: current ?? null, after: next});
    await input.authorize(); // Including attachment commit after bytes are uploaded.
    requireThat(await this.save(shopId, state), "Concurrent inspection edit. Compare the saved version before retrying.", 409);
    return saved;
  }
}
