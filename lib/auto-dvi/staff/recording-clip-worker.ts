import {randomUUID} from "node:crypto";
import {recordingContext, type RecordingDependencies} from "./recording-service";
import type {RecordingMediaStorage} from "./recording-media";
import {prepareSilentRecordingClip} from "./recording-container";
import {requireThat} from "../../shop-dispatch/model";
import {digest} from "../../shop-dispatch/service";
import {writeContext} from "./service";
import type {StaffInspection} from "./model";

export async function processRecordingClip(scope: {visitId: string; id: string}, clipId: string,
  deps: RecordingDependencies, media: RecordingMediaStorage,
  convert = prepareSilentRecordingClip, now: () => number = Date.now) {
  const ctx = await recordingContext(scope, deps), token = randomUUID();
  const original = ctx.record.clips?.find(c => c.id === clipId);
  requireThat(original, "Clip request not found", 404);
  if (original.state === "ready") return ctx.record;
  const authorize = async () => {
    await ctx.authorize();
    const latest = await writeContext(scope.visitId, deps.staff, {...ctx.context.access, identity: ctx.context.record.identity});
    const inspection = latest.record.results.staff as StaffInspection;
    const item = inspection.sheets.find(s => s.active && s.key === original.target.sheet)?.sheet.items.find(i => i.id === original.target.item);
    requireThat(item && digest(item) === original.target.definitionHash, "Clip checklist changed", 409);
  };
  const claimed = await deps.repository.mutate(ctx.record, authorize, record => {
    const clip = record.clips?.find(c => c.id === clipId)!;
    requireThat(clip.state !== "ready" && clip.attempts < 3 && (!clip.lease || clip.lease.until <= now()) &&
      !record.clips?.some(c => c.id !== clipId && c.lease && c.lease.until > now()) &&
      !record.segments.some(s => s.lease && s.lease.until > now()), "Clip processing is unavailable or already claimed", 409);
    clip.state = "processing"; clip.attempts++; clip.lease = {token, until: now() + 90_000};
  });
  const source = claimed.segments.find(s => s.sequence === original.sequence)!;
  const signal = AbortSignal.timeout(40_000);
  try {
    const owner = {shopId: claimed.shopId, visitId: claimed.visitId, recordingId: claimed.id, actor: claimed.actor};
    const raw = await media.read(owner, source.mediaId, source.digest);
    const silent = await convert(raw.bytes, original.startSeconds, original.endSeconds, signal);
    await authorize();
    const stored = await media.upload(owner, silent.bytes, "video/mp4", true);
    return await deps.repository.mutate(ctx.record, authorize, record => {
      const clip = record.clips?.find(c => c.id === clipId)!;
      requireThat(clip.lease?.token === token && clip.lease.until > now(), "Clip processing lease changed", 409);
      clip.state = "ready"; clip.lease = null; clip.mediaId = stored.id;
      clip.digest = stored.digest; clip.durationSeconds = silent.durationSeconds;
    });
  } catch (error) {
    await deps.repository.mutate(ctx.record, authorize, record => {
      const clip = record.clips?.find(c => c.id === clipId)!;
      requireThat(clip.lease?.token === token && clip.lease.until > now(), "Clip processing lease changed", 409);
      clip.state = "failed"; clip.lease = null;
    });
    throw error;
  }
}
