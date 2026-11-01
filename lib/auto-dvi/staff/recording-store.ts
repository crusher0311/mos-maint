import {z} from "zod";
import {randomUUID} from "node:crypto";
import type {Db} from "mongodb";
import {getDb} from "../../data/db";
import {requireThat} from "../../shop-dispatch/model";
import {appendRecordingSegment, claimRecordingSegment, finishRecordingSegment,
  recordingSegmentSchema, recordingTargetSchema, recordingClipSchema, type RecordingSegment} from "./recording-model";

export const recordingSchema = z.object({
  id: z.string().uuid(), shopId: z.number().int().positive(), visitId: z.string().min(1).max(100),
  actor: z.string().min(1).max(200), identityDigest: z.string().length(64),
  contributorEmail: z.string().email().max(320),
  inspectionRevision: z.number().int().nonnegative(), policyVersion: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(), createdAt: z.string().datetime(),
  state: z.enum(["open", "stopped"]),
  targets: z.array(recordingTargetSchema).max(200),
  segments: z.array(recordingSegmentSchema).max(30),
  clips: z.array(recordingClipSchema).max(30).optional(),
}).strict();
export type Recording = z.infer<typeof recordingSchema>;
export interface RecordingPersistence {
  read(shopId: number, visitId: string, id: string): Promise<Recording | null>;
  insert(value: Recording): Promise<boolean>;
  cas(before: Recording, after: Recording): Promise<boolean>;
}
const collection = "workflow_staff_recordings";
const key = (shopId: number, visitId: string, id: string) => JSON.stringify([shopId, visitId, id]);
const writeConcern = {w: "majority" as const, wtimeoutMS: 5000};
/** No indexes or migrations on startup. Exact primary-key operations only. */
export class MongoRecordingPersistence implements RecordingPersistence {
  constructor(private database: () => Promise<Db> = getDb) {}
  async preparedClips(shopId: number, visitId: string) {
    const rows = await (await this.database()).collection(collection).find({shopId, visitId,
      "clips.state": "ready"}, {maxTimeMS: 2000}).limit(100).toArray();
    return rows.flatMap(({_id, ...value}) => {
      const recording = recordingSchema.parse(value);
      return (recording.clips ?? []).filter(c => c.state === "ready" && c.mediaId && c.digest && c.durationSeconds).map(c => ({
        id: c.mediaId!, caption: c.caption, durationSeconds: c.durationSeconds!,
        sheet: c.target.sheet, item: c.target.item, definitionHash: c.target.definitionHash,
        identityDigest: recording.identityDigest,
      }));
    });
  }
  async pending(shopId: number, now: number) {
    const rows = await (await this.database()).collection(collection).find({shopId, $or: [{
      segments: {$elemMatch: {attempts: {$lt: 3}, $or: [
        {state: "uploaded"}, {state: "processing", "lease.until": {$lte: now}},
      ]}},
    }, {clips: {$elemMatch: {attempts: {$lt: 3}, $or: [
      {state: "queued"}, {state: "processing", "lease.until": {$lte: now}},
    ]}}}]}, {maxTimeMS: 2000}).limit(10).toArray();
    return rows.map(({_id, ...value}) => recordingSchema.parse(value));
  }
  async countRecent(shopId: number, since: string) {
    return (await this.database()).collection(collection).countDocuments({shopId, createdAt: {$gte: since}},
      {maxTimeMS: 2000, limit: 101});
  }
  async read(shopId: number, visitId: string, id: string) {
    const row = await (await this.database()).collection(collection).findOne({_id: key(shopId, visitId, id)} as any, {maxTimeMS: 2000});
    if (!row) return null;
    const {_id, ...value} = row;
    return recordingSchema.parse(value);
  }
  async insert(value: Recording) {
    const parsed = recordingSchema.parse(value);
    try {
      await (await this.database()).collection(collection).insertOne({
        _id: key(parsed.shopId, parsed.visitId, parsed.id), ...parsed,
      } as any, {writeConcern});
      return true;
    } catch (error) {if ((error as {code?: number}).code === 11000) return false; throw error;}
  }
  async cas(before: Recording, after: Recording) {
    const parsed = recordingSchema.parse(after);
    requireThat(parsed.shopId === before.shopId && parsed.visitId === before.visitId && parsed.id === before.id &&
      parsed.revision === before.revision + 1, "Recording identity/revision changed", 409);
    requireThat(Buffer.byteLength(JSON.stringify(parsed)) < 2 * 1024 * 1024, "Recording metadata capacity reached", 409);
    return (await (await this.database()).collection(collection).replaceOne({
      _id: key(before.shopId, before.visitId, before.id), revision: before.revision,
    } as any, {_id: key(before.shopId, before.visitId, before.id), ...parsed} as any,
    {writeConcern})).modifiedCount === 1;
  }
}
export class RecordingRepository {
  constructor(readonly store: RecordingPersistence) {}
  async create(value: Recording, authorize: () => Promise<void>) {
    const parsed = recordingSchema.parse(value);
    requireThat(parsed.revision === 0 && parsed.state === "open" && !parsed.segments.length, "Blank recording admission required", 400);
    await authorize();
    const prior = await this.store.read(parsed.shopId, parsed.visitId, parsed.id);
    if (prior) {
      requireThat(prior.actor === parsed.actor && prior.identityDigest === parsed.identityDigest &&
        prior.inspectionRevision === parsed.inspectionRevision && prior.policyVersion === parsed.policyVersion &&
        JSON.stringify(prior.targets) === JSON.stringify(parsed.targets), "Recording admission receipt conflicts", 409);
      return prior;
    }
    await authorize();
    requireThat(await this.store.insert(parsed), "Concurrent recording admission; recover the same recording ID", 409);
    return parsed;
  }
  async mutate(scope: {shopId: number; visitId: string; id: string}, authorize: () => Promise<void>,
    change: (record: Recording) => void) {
    await authorize();
    const before = await this.store.read(scope.shopId, scope.visitId, scope.id);
    requireThat(before, "Recording not found", 404);
    const after = structuredClone(before);
    change(after);
    after.revision++;
    await authorize();
    requireThat(await this.store.cas(before, after), "Recording changed; reload its receipts before retry", 409);
    return after;
  }
  async append(scope: {shopId: number; visitId: string; id: string}, segment: RecordingSegment, authorize: () => Promise<void>) {
    return this.mutate(scope, authorize, record => {
      // Allow exact uploaded-segment recovery after Stop, but never new footage.
      requireThat(record.state === "open" || record.segments.some(s => s.sequence === segment.sequence), "Recording is stopped", 409);
      record.segments = appendRecordingSegment(record.segments, segment);
    });
  }
  async claim(scope: {shopId: number; visitId: string; id: string}, sequence: number, now: number, authorize: () => Promise<void>) {
    const token = randomUUID();
    const record = await this.mutate(scope, authorize, record => {
      requireThat(!record.clips?.some(c => c.lease && c.lease.until > now), "A clip is processing for this recording", 409);
      requireThat(!record.segments.some(s => s.sequence !== sequence && s.state === "processing" &&
        s.lease && s.lease.until > now), "Another segment is processing for this recording", 409);
      const index = record.segments.findIndex(s => s.sequence === sequence);
      requireThat(index >= 0, "Uploaded segment receipt required", 409);
      record.segments[index] = claimRecordingSegment(record.segments[index], token, now);
    });
    return {record, token};
  }
  async finish(scope: {shopId: number; visitId: string; id: string}, sequence: number, token: string,
    now: number, outcome: {drafts: unknown[]} | {error: string}, authorize: () => Promise<void>) {
    return this.mutate(scope, authorize, record => {
      const index = record.segments.findIndex(s => s.sequence === sequence);
      requireThat(index >= 0, "Segment receipt not found", 409);
      record.segments[index] = finishRecordingSegment(record.segments[index], token, now, outcome);
    });
  }
}
