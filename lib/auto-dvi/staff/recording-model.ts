import {z} from "zod";
import {requireThat} from "../../shop-dispatch/model";

/** Foreground segments are independent containers, not arbitrary MediaRecorder
 * timeslices. Raw media and suggestions remain private until explicit review. */
export const RECORDING_LIMITS = {
  segmentBytes: 4 * 1024 * 1024,
  segments: 30,
  segmentSeconds: 15,
  processingAttempts: 3,
  leaseMs: 90_000,
} as const;
export const recordingTargetSchema = z.object({
  sheet: z.string().min(1).max(80), item: z.string().min(1).max(80),
  name: z.string().min(1).max(160), definitionHash: z.string().length(64),
}).strict();
export const recordingDraftSchema = z.object({
  id: z.string().min(1).max(100), target: recordingTargetSchema.nullable(),
  source: z.literal("narration"), rating: z.enum(["red", "yellow", "green"]).nullable(),
  notes: z.string().max(2000), caption: z.string().max(2000),
  startSeconds: z.number().finite().min(0).max(15),
  endSeconds: z.number().finite().positive().max(15),
  confirmed: z.literal(false),
}).strict().refine(d => d.endSeconds > d.startSeconds, "Source timestamps must be ordered");
export const recordingSegmentSchema = z.object({
  sequence: z.number().int().min(0).max(RECORDING_LIMITS.segments - 1),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().positive().max(RECORDING_LIMITS.segmentBytes),
  mime: z.enum(["video/webm", "video/mp4", "audio/webm", "audio/mp4"]),
  durationSeconds: z.number().finite().positive().max(RECORDING_LIMITS.segmentSeconds),
  mediaId: z.string().regex(/^[a-f0-9]{24}$/),
  state: z.enum(["uploaded", "processing", "processed", "failed"]),
  attempts: z.number().int().min(0).max(RECORDING_LIMITS.processingAttempts),
  lease: z.object({token: z.string().uuid(), until: z.number().finite()}).strict().nullable(),
  drafts: z.array(recordingDraftSchema).max(30),
  error: z.string().max(200).nullable(),
}).strict();
export type RecordingSegment = z.infer<typeof recordingSegmentSchema>;
export const recordingClipSchema = z.object({
  id: z.string().uuid(), sequence: z.number().int().min(0).max(29),
  draftId: z.string().min(1).max(100), target: recordingTargetSchema,
  startSeconds: z.number().finite().min(0), endSeconds: z.number().finite().positive().max(15),
  caption: z.string().trim().min(1).max(2000),
  requestedAt: z.string().datetime(), requestedBy: z.string().min(1).max(200),
  state: z.enum(["queued", "processing", "ready", "failed"]),
  attempts: z.number().int().min(0).max(3),
  lease: z.object({token: z.string().uuid(), until: z.number().finite()}).strict().nullable(),
  mediaId: z.string().regex(/^[a-f0-9]{24}$/).nullable(),
  digest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  durationSeconds: z.number().finite().positive().max(15).nullable(),
}).strict().refine(value => value.endSeconds > value.startSeconds, "Selected clip range must be ordered");
export type RecordingClip = z.infer<typeof recordingClipSchema>;

/** A stale worker can neither overwrite corrections nor publish late results.
 * Persist the returned value with the same aggregate CAS as the claim. */
export function claimRecordingSegment(segment: RecordingSegment, token: string, now: number): RecordingSegment {
  requireThat(segment.state !== "processed", "This segment already has a processing receipt", 409);
  requireThat(!segment.lease || segment.lease.until <= now, "Segment processing is already in progress", 409);
  requireThat(segment.attempts < RECORDING_LIMITS.processingAttempts, "Processing retry limit reached; retain footage for manual review", 409);
  return recordingSegmentSchema.parse({...segment, state: "processing", attempts: segment.attempts + 1,
    lease: {token, until: now + RECORDING_LIMITS.leaseMs}, error: null});
}
export function finishRecordingSegment(segment: RecordingSegment, token: string, now: number,
  outcome: {drafts: unknown[]} | {error: string}): RecordingSegment {
  requireThat(segment.state === "processing" && segment.lease?.token === token && segment.lease.until > now,
    "Processing lease changed; late output was not applied", 409);
  if ("error" in outcome) return recordingSegmentSchema.parse({...segment, state: "failed",
    lease: null, error: outcome.error.slice(0, 200)});
  const drafts = z.array(recordingDraftSchema).max(30).parse(outcome.drafts);
  requireThat(drafts.every(d => d.endSeconds <= segment.durationSeconds), "Draft source exceeds retained footage", 400);
  requireThat(new Set(drafts.map(d => d.id)).size === drafts.length, "Duplicate draft identities", 400);
  return recordingSegmentSchema.parse({...segment, state: "processed", lease: null, drafts, error: null});
}
export function appendRecordingSegment(segments: RecordingSegment[], incoming: unknown): RecordingSegment[] {
  const segment = recordingSegmentSchema.parse(incoming);
  const previous = segments.find(s => s.sequence === segment.sequence);
  if (previous) {
    requireThat(previous.digest === segment.digest && previous.bytes === segment.bytes && previous.mime === segment.mime &&
      previous.durationSeconds === segment.durationSeconds, "Exact original segment required for retry", 409);
    return segments;
  }
  requireThat(segment.state === "uploaded" && segment.attempts === 0 && !segment.lease && !segment.drafts.length && !segment.error,
    "New segments cannot supply processing results", 400);
  requireThat(segments.length < RECORDING_LIMITS.segments, "Recording storage limit reached", 409);
  return [...segments, segment].sort((a, b) => a.sequence - b.sequence);
}
