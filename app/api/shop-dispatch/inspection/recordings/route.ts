import {z, ZodError} from "zod";
import {dispatchFailure, dispatchJson, requestBody} from "@/lib/shop-dispatch/http";
import {requireThat} from "@/lib/shop-dispatch/model";
import {recordingContext, startRecording, stopRecording, uploadRecordingSegment, requestRecordingClip, retryRecordingProcessing} from "@/lib/auto-dvi/staff/recording-service";
import {recordingDependencies as deps, recordingMedia as media} from "@/lib/auto-dvi/staff/recording-runtime";
import {RECORDING_LIMITS} from "@/lib/auto-dvi/staff/recording-model";
import type {Recording} from "@/lib/auto-dvi/staff/recording-store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const actions = z.discriminatedUnion("action", [
  z.object({action: z.literal("start"), visitId: z.string().min(1).max(100), id: z.string().uuid(),
    inspectionRevision: z.number().int().nonnegative()}).strict(),
  z.object({action: z.literal("stop"), visitId: z.string().min(1).max(100), id: z.string().uuid()}).strict(),
  z.object({action: z.literal("retry-processing"), visitId: z.string().min(1).max(100), id: z.string().uuid()}).strict(),
  z.object({action: z.literal("clip"), visitId: z.string().min(1).max(100), id: z.string().uuid(),
    clipId: z.string().uuid(), sequence: z.number().int().min(0).max(29), draftId: z.string().min(1).max(100),
    startSeconds: z.number().finite().min(0), endSeconds: z.number().finite().positive().max(15),
    caption: z.string().trim().min(1).max(2000), confirmCaptionAndSelection: z.literal(true)}).strict(),
]);
function response(recording: Recording) {
  const {contributorEmail: _, ...publicRecording} = recording;
  return dispatchJson({recording: publicRecording, scope: JSON.stringify([recording.shopId, recording.actor, recording.visitId])});
}
export async function GET(req: Request) {
  try {
    const query = new URL(req.url).searchParams;
    const ctx = await recordingContext({visitId: query.get("visitId"), id: query.get("id")}, deps);
    if (query.has("mediaId")) {
      const id = query.get("mediaId")!;
      requireThat(ctx.record.clips?.some(c => c.state === "ready" && c.mediaId === id), "Prepared clip unavailable", 404);
      const file = await media.readReleased(id, ctx.record.shopId, ctx.record.visitId);
      await ctx.authorize();
      return new Response(new Uint8Array(file.bytes), {headers: {"Content-Type": file.mime, "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff"}});
    }
    return response(ctx.record);
  } catch (error) {return error instanceof ZodError ? dispatchJson({error: "Invalid recording identity"}, 400) : dispatchFailure(error);}
}
export async function POST(req: Request) {
  try {
    if (req.headers.get("content-type")?.startsWith("application/json")) {
      const {action, ...body} = actions.parse(await requestBody(req, 12000));
      return response(action === "start" ? await startRecording(body, deps) :
        action === "clip" ? await requestRecordingClip(body, deps) :
        action === "retry-processing" ? await retryRecordingProcessing(body, deps) : await stopRecording(body, deps));
    }
    // Authorize before consuming raw media. Still reauthorize at the actual
    // visit/media commit boundary after the bounded upload finishes.
    await deps.staff.access();
    const origin = req.headers.get("origin"), host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    requireThat(origin && new URL(origin).host === host && req.headers.get("sec-fetch-site") !== "cross-site",
      "Same-origin recording upload required", 403);
    const reader = req.body?.getReader();
    requireThat(reader, "Recording upload required", 400);
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length;
      if (size > RECORDING_LIMITS.segmentBytes + 16000) {
        await reader.cancel(); requireThat(false, "Recording segment exceeds 4 MiB", 413);
      }
      chunks.push(next.value);
    }
    const form = await new Response(Buffer.concat(chunks), {headers: {
      "content-type": req.headers.get("content-type") ?? "",
    }}).formData();
    const file = form.get("file");
    requireThat(file instanceof File && file.size > 0, "Choose a recording segment", 400);
    requireThat(form.has("sequence") && form.has("durationSeconds"), "Recording sequence and duration required", 400);
    return response(await uploadRecordingSegment({
      visitId: form.get("visitId"), id: form.get("id"), sequence: Number(form.get("sequence")),
      durationSeconds: Number(form.get("durationSeconds")), mime: form.get("mime"),
    }, Buffer.from(await file.arrayBuffer()), deps, media));
  } catch (error) {
    return error instanceof ZodError || error instanceof SyntaxError ? dispatchJson({error: "Invalid recording request"}, 400) : dispatchFailure(error);
  }
}
