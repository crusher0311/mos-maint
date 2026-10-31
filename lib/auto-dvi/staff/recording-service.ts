import {z} from "zod";
import {digest} from "../../shop-dispatch/service";
import {requireThat} from "../../shop-dispatch/model";
import {writeContext, type StaffDependencies} from "./service";
import type {StaffInspection} from "./model";
import {RecordingRepository, MongoRecordingPersistence, type Recording} from "./recording-store";
import {RecordingMediaStorage, recordingMediaDigest} from "./recording-media";
import {recordingSegmentSchema, RECORDING_LIMITS, recordingClipSchema} from "./recording-model";

const scopeSchema = z.object({
  visitId: z.string().min(1).max(100), id: z.string().uuid(),
}).strict();
export const startRecordingSchema = scopeSchema.extend({
  inspectionRevision: z.number().int().nonnegative(),
}).strict();
export interface RecordingDependencies {
  staff: StaffDependencies;
  repository: RecordingRepository;
}
export async function recordingContext(raw: unknown, deps: RecordingDependencies) {
  const request = scopeSchema.parse(raw);
  const context = await writeContext(request.visitId, deps.staff);
  requireThat(context.access.config?.recording?.enabledShopIds.includes(context.access.shopId),
    "Foreground recording is not enabled for this shop", 403);
  const inspection = context.record.results.staff as StaffInspection | undefined;
  requireThat(inspection, "Initialize the visit inspection before recording", 409);
  const record = await deps.repository.store.read(context.access.shopId, request.visitId, request.id);
  requireThat(record && record.actor === context.access.actor &&
    record.identityDigest === digest(context.record.identity), "Recording is not available to this visit and contributor", 403);
  const authorize = async () => {
    const latest = await writeContext(request.visitId, deps.staff, {...context.access, identity: context.record.identity});
    requireThat(digest(latest.access.config) === digest(context.access.config), "Inspection policy changed; reload recording", 409);
  };
  await authorize();
  return {request, record, context, inspection, authorize};
}
export async function startRecording(raw: unknown, deps: RecordingDependencies) {
  const request = startRecordingSchema.parse(raw), context = await writeContext(request.visitId, deps.staff);
  requireThat(context.access.config?.recording?.enabledShopIds.includes(context.access.shopId),
    "Foreground recording is not enabled for this shop", 403);
  const inspection = context.record.results.staff as StaffInspection | undefined;
  requireThat(inspection, "Initialize the visit inspection before recording", 409);
  const previous = await deps.repository.store.read(context.access.shopId, request.visitId, request.id);
  // An exact admission retry must not require rolling back later evidence edits.
  if (previous) {
    const recovered = await recordingContext({visitId: request.visitId, id: request.id}, deps);
    requireThat(recovered.record.inspectionRevision === request.inspectionRevision, "Original recording admission required", 409);
    return recovered.record;
  }
  requireThat(inspection.revision === request.inspectionRevision, "Inspection changed; reload before recording", 409);
  // Coarse shop admission bound complements per-recording media/attempt caps.
  // This is not billing accounting or an atomic cross-replica quota.
  if (deps.repository.store instanceof MongoRecordingPersistence) {
    const since = new Date(Date.parse(deps.staff.now()) - 24 * 60 * 60 * 1000).toISOString();
    requireThat(await deps.repository.store.countRecent(context.access.shopId, since) < 100,
      "Daily recording admission limit reached; use photos and manual findings", 429);
  }
  const targets = inspection.sheets.filter(s => s.active).flatMap(s => s.sheet.items.map(item => ({
    sheet: s.key, item: item.id, name: item.name, definitionHash: digest(item),
  })));
  requireThat(targets.length <= 200, "Reduce active checks before recording", 409);
  const recording: Recording = {id: request.id, shopId: context.access.shopId, visitId: request.visitId,
    actor: context.access.actor, contributorEmail: context.access.email, identityDigest: digest(context.record.identity),
    inspectionRevision: inspection.revision, policyVersion: inspection.policy?.version ?? 0,
    revision: 0, createdAt: deps.staff.now(), state: "open", targets, segments: []};
  return deps.repository.create(recording, async () => {
    const latest = await writeContext(request.visitId, deps.staff, {...context.access, identity: context.record.identity});
    requireThat((latest.record.results.staff as StaffInspection)?.revision === inspection.revision &&
      digest(latest.access.config) === digest(context.access.config), "Inspection changed during recording admission", 409);
  });
}
export async function stopRecording(raw: unknown, deps: RecordingDependencies) {
  const ctx = await recordingContext(raw, deps);
  if (ctx.record.state === "stopped") return ctx.record;
  return deps.repository.mutate(ctx.record, ctx.authorize, record => {record.state = "stopped";});
}
export async function retryRecordingProcessing(raw: unknown, deps: RecordingDependencies) {
  const ctx = await recordingContext(raw, deps);
  return deps.repository.mutate(ctx.record, ctx.authorize, record => {
    for (const segment of record.segments) if (segment.state === "failed" && segment.attempts < 3) {
      segment.state = "uploaded"; segment.error = null;
    }
    for (const clip of record.clips ?? []) if (clip.state === "failed" && clip.attempts < 3) clip.state = "queued";
  });
}
const uploadSegmentSchema = scopeSchema.extend({
  sequence: z.number().int().min(0).max(RECORDING_LIMITS.segments - 1),
  durationSeconds: z.number().finite().positive().max(RECORDING_LIMITS.segmentSeconds),
  mime: z.enum(["video/webm", "video/mp4", "audio/webm", "audio/mp4"]),
}).strict();
export async function uploadRecordingSegment(raw: unknown, bytes: Buffer,
  deps: RecordingDependencies, media: RecordingMediaStorage) {
  const request = uploadSegmentSchema.parse(raw);
  requireThat(bytes.length > 0 && bytes.length <= RECORDING_LIMITS.segmentBytes, "Recording segment exceeds 4 MiB", 413);
  const ctx = await recordingContext({visitId: request.visitId, id: request.id}, deps);
  const hash = recordingMediaDigest(bytes);
  const prior = ctx.record.segments.find(s => s.sequence === request.sequence);
  if (prior) {
    requireThat(prior.digest === hash && prior.bytes === bytes.length && prior.mime === request.mime &&
      prior.durationSeconds === request.durationSeconds, "Exact original recording segment required", 409);
    await ctx.authorize();
    return ctx.record;
  }
  requireThat(ctx.record.state === "open", "Recording is stopped; pending footage remains local", 409);
  const stored = await media.upload({shopId: ctx.record.shopId, visitId: ctx.record.visitId,
    recordingId: ctx.record.id, actor: ctx.record.actor}, bytes, request.mime);
  await ctx.authorize();
  return deps.repository.append(ctx.record, recordingSegmentSchema.parse({
    sequence: request.sequence, digest: stored.digest, bytes: stored.bytes, mime: request.mime,
    durationSeconds: request.durationSeconds, mediaId: stored.id,
    state: "uploaded", attempts: 0, lease: null, drafts: [], error: null,
  }), ctx.authorize);
}
const clipRequestSchema = scopeSchema.extend({
  clipId: z.string().uuid(), sequence: z.number().int().min(0).max(29),
  draftId: z.string().min(1).max(100), startSeconds: z.number().finite().min(0),
  endSeconds: z.number().finite().positive().max(15),
  caption: z.string().trim().min(1).max(2000), confirmCaptionAndSelection: z.literal(true),
}).strict();
export async function requestRecordingClip(raw: unknown, deps: RecordingDependencies) {
  const request = clipRequestSchema.parse(raw);
  const ctx = await recordingContext({visitId: request.visitId, id: request.id}, deps);
  return deps.repository.mutate(ctx.record, ctx.authorize, recording => {
    const segment = recording.segments.find(s => s.sequence === request.sequence);
    const draft = segment?.drafts.find(d => d.id === request.draftId);
    requireThat(segment?.state === "processed" && segment.mime.startsWith("video/") && draft?.target,
      "A processed narration finding with matching video is required", 409);
    const target = draft.target;
    const sheet = ctx.inspection.sheets.find(s => s.active && s.key === target.sheet);
    const item = sheet?.sheet.items.find(i => i.id === target.item);
    requireThat(item && digest(item) === target.definitionHash,
      "Clip target checklist changed", 409);
    requireThat(request.endSeconds > request.startSeconds && request.endSeconds <= segment.durationSeconds,
      "Select a range inside the retained segment", 400);
    const existing = recording.clips?.find(c => c.id === request.clipId);
    if (existing) {
      requireThat(existing.sequence === request.sequence && existing.draftId === request.draftId &&
        existing.startSeconds === request.startSeconds && existing.endSeconds === request.endSeconds &&
        existing.caption === request.caption, "Exact original clip request required", 409);
      return;
    }
    recording.clips ??= [];
    requireThat(recording.clips.length < 30, "Clip preparation limit reached", 409);
    recording.clips.push(recordingClipSchema.parse({
      id: request.clipId, sequence: request.sequence, draftId: request.draftId, target,
      startSeconds: request.startSeconds, endSeconds: request.endSeconds, caption: request.caption,
      requestedAt: deps.staff.now(), requestedBy: ctx.context.access.actor, state: "queued",
      attempts: 0, lease: null, mediaId: null, digest: null, durationSeconds: null,
    }));
  });
}
