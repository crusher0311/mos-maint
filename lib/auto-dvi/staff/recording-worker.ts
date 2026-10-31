import {digest} from "../../shop-dispatch/service";
import {requireThat} from "../../shop-dispatch/model";
import {writeContext} from "./service";
import type {StaffInspection} from "./model";
import {recordingContext, type RecordingDependencies} from "./recording-service";
import type {RecordingMediaStorage} from "./recording-media";
import type {Recording} from "./recording-store";

export interface RecordingProcessor {
  /** Implementations must probe the container and actual duration before AI,
   * enforce usage budgets and return narration-only candidates. No public media
   * or staff evidence may be produced as a side effect. */
  process(input: {bytes: Buffer; mime: string; maximumSeconds: number; targets: Recording["targets"];
    shopId: number; sequence: number; signal: AbortSignal}): Promise<{drafts: unknown[]}>;
}
/** One bounded leased unit, for a dedicated worker, never a blocking upload
 * handler. Dependencies supply current membership authority on every check. */
export async function processRecordingSegment(scope: {visitId: string; id: string}, sequence: number,
  deps: RecordingDependencies, media: RecordingMediaStorage, processor: RecordingProcessor,
  now: () => number = Date.now) {
  const ctx = await recordingContext(scope, deps);
  const existing = ctx.record.segments.find(s => s.sequence === sequence);
  requireThat(existing, "Upload receipt required before processing", 409);
  if (existing.state === "processed") return ctx.record;
  requireThat(!ctx.record.segments.some(s => s.sequence !== sequence && s.state === "processing" &&
    s.lease && s.lease.until > now()), "Another segment is processing for this recording", 409);
  const authorize = async () => {
    await ctx.authorize();
    const latest = await writeContext(scope.visitId, deps.staff, {...ctx.context.access, identity: ctx.context.record.identity});
    const inspection = latest.record.results.staff as StaffInspection;
    // Sheet changes cannot redirect output to different procedures or units.
    requireThat(ctx.record.targets.every(target => {
      const sheet = inspection.sheets.find(s => s.active && s.key === target.sheet);
      const item = sheet?.sheet.items.find(i => i.id === target.item);
      return item && digest(item) === target.definitionHash;
    }), "Recording checklist changed; retain footage for manual review", 409);
  };
  const claim = await deps.repository.claim(ctx.record, sequence, now(), authorize);
  const segment = claim.record.segments.find(s => s.sequence === sequence)!;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const work = (async () => {
      const raw = await media.read({shopId: ctx.record.shopId, visitId: scope.visitId,
        recordingId: scope.id, actor: ctx.record.actor}, segment.mediaId, segment.digest);
      await authorize();
      controller.signal.throwIfAborted();
      return processor.process({bytes: raw.bytes, mime: raw.mime, maximumSeconds: segment.durationSeconds,
        targets: ctx.record.targets, shopId: ctx.record.shopId, sequence, signal: controller.signal});
    })();
    const outcome = await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => {controller.abort(); reject(Error("Processing deadline exceeded"));}, 60_000);
    })]);
    return await deps.repository.finish(ctx.record, sequence, claim.token, now(), outcome, authorize);
  } catch {
    // Generic, content-free error only. Raw provider responses may contain
    // transcripts, credentials or other private material.
    return deps.repository.finish(ctx.record, sequence, claim.token, now(),
      {error: "Processing did not complete. Original footage is retained for retry or manual review."}, authorize);
  } finally {if (timer) clearTimeout(timer); controller.abort();}
}
