import type { Db } from "mongodb";
import { z } from "zod";
import { getDb } from "../../data/db";
import { requireThat } from "../../shop-dispatch/model";
import { customerReportSchema, selectionSchema, type CustomerReport, type ReleaseSelection } from "./model";

export interface Preview {
  id: string; shopId: number; visitId: string; actor: string; at: string;
  digest: string; selectedDigest: string; contextDigest: string;
  selection: ReleaseSelection; report: CustomerReport; excludedHazards: {key: string; title: string}[];
  identity: unknown; baseVersion: number;
}
export interface PublishedVersion {version: number; requestId: string; requestDigest: string; actor: string; at: string; preview: Preview}
export interface ReportLink {id: string; hash: string; expiresAt: string; revokedAt: string | null}
export interface ReleaseState {
  revision: number; versions: PublishedVersion[]; latest: number;
  previews: Preview[];
  pending: {requestId: string; actor: string; digest: string; preview: Preview; at: string} | null;
  links: ReportLink[]; receipts: {requestId: string; actor: string; digest: string; linkId: string}[];
}
const empty = (): ReleaseState => ({revision: 0, versions: [], previews: [], latest: 0, pending: null, links: [], receipts: []});
const hash = z.string().regex(/^[a-f0-9]{64}$/), actor = z.string().min(1).max(200);
const previewSchema = z.object({
  id: z.string().uuid(), shopId: z.number().int().positive(), visitId: z.string().min(1).max(100),
  actor, at: z.string().datetime(), digest: hash, selectedDigest: hash, contextDigest: hash,
  selection: selectionSchema, report: customerReportSchema,
  excludedHazards: z.array(z.object({key: z.string().max(170), title: z.string().max(160)}).strict()).max(1200),
  identity: z.object({version: z.literal(1), shopId: z.number().int().positive(),
    workflowVisitId: z.string().min(1).max(100), provider: z.enum(["manual", "protractor"]),
    providerWorkOrderId: z.string().uuid().nullable()}).strict(),
  baseVersion: z.number().int().nonnegative(),
}).strict();
const stateSchema = z.object({
  revision: z.number().int().nonnegative(), latest: z.number().int().nonnegative(),
  previews: z.array(previewSchema).max(20),
  versions: z.array(z.object({version: z.number().int().positive(), requestId: z.string().uuid(), requestDigest: hash,
    actor, at: z.string().datetime(), preview: previewSchema}).strict()).max(100),
  pending: z.object({requestId: z.string().uuid(), actor, digest: hash, preview: previewSchema,
    at: z.string().datetime()}).strict().nullable(),
  links: z.array(z.object({id: hash, hash, expiresAt: z.string().datetime(), revokedAt: z.string().datetime().nullable()}).strict()).max(100),
  receipts: z.array(z.object({requestId: z.string().uuid(), actor, digest: hash, linkId: hash}).strict()).max(1000),
}).strict();
export interface ReleaseStorage {
  read(shopId: number, visitId: string): Promise<ReleaseState>;
  cas(shopId: number, visitId: string, state: ReleaseState): Promise<boolean>;
  savePreview(preview: Preview): Promise<void>;
  preview(id: string, shopId: number, visitId: string): Promise<Preview | null>;
}
/** Per-visit bounded records; never embedded in the shop's staff aggregate. No
 * indexes/collections are provisioned on startup. Operators own provisioning. */
export class MongoReleaseStorage implements ReleaseStorage {
  constructor(private database: () => Promise<Db> = getDb) {}
  async read(shopId: number, visitId: string) {
    const row = await (await this.database()).collection("workflow_inspection_releases")
      .findOne({_id: `${shopId}:${visitId}`} as any, {maxTimeMS: 5000});
    if (!row) return empty();
    const {_id, ...state} = row;
    return stateSchema.parse(state) as ReleaseState;
  }
  async cas(shopId: number, visitId: string, state: ReleaseState) {
    requireThat(state.versions.length <= 100 && state.previews.length <= 20 && state.links.length <= 100 && state.receipts.length <= 1000 &&
      Buffer.byteLength(JSON.stringify(state)) < 8 * 1024 * 1024, "Release retention capacity reached", 409);
    const col = (await this.database()).collection("workflow_inspection_releases");
    const doc = {_id: `${shopId}:${visitId}`, ...stateSchema.parse(state), revision: state.revision + 1};
    if (!state.revision) {
      try {await col.insertOne(doc as any, {writeConcern: {w: "majority", wtimeoutMS: 5000}}); return true;}
      catch (e) {if ((e as {code?: number}).code === 11000) return false; throw e;}
    }
    return (await col.replaceOne({_id: doc._id, revision: state.revision} as any, doc as any,
      {writeConcern: {w: "majority", wtimeoutMS: 5000}})).modifiedCount === 1;
  }
  async savePreview(preview: Preview) {
    requireThat(Buffer.byteLength(JSON.stringify(preview)) < 300000, "Preview is too large", 400);
    const state = await this.read(preview.shopId, preview.visitId);
    state.previews = state.previews.filter(p => Date.parse(preview.at) - Date.parse(p.at) < 15 * 60_000 ||
      p.id === state.pending?.preview.id);
    state.previews.push(preview);
    requireThat(await this.cas(preview.shopId, preview.visitId, state), "Concurrent preview change; retry preview", 409);
  }
  async preview(id: string, shopId: number, visitId: string) {
    const state = await this.read(shopId, visitId);
    return state.previews.find(p => p.id === id) ?? state.versions.find(v => v.preview.id === id)?.preview ?? null;
  }
}
