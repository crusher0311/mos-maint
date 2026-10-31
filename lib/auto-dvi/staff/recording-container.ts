import {execFile} from "node:child_process";
import {mkdtemp, writeFile, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {requireThat} from "../../shop-dispatch/model";
import {RECORDING_LIMITS} from "./recording-model";

function command(binary: string, args: string[], signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => execFile(binary, args, {
    signal, timeout: 12_000, maxBuffer: 128 * 1024, windowsHide: true,
  }, (error, stdout) => error ? reject(Error("Recording codec processing unavailable or invalid media")) : resolve(stdout)));
}
/** Fixed local paths, no URL input, no shell, no external codec protocols.
 * This adapter is not a claim that ffmpeg is installed on the serving worker. */
export async function prepareRecordingContainer(bytes: Buffer, maximumSeconds: number, signal: AbortSignal) {
  requireThat(bytes.length > 0 && bytes.length <= RECORDING_LIMITS.segmentBytes, "Recording segment exceeds limits", 413);
  const directory = await mkdtemp(join(tmpdir(), "dvi-segment-"));
  try {
    const source = join(directory, "source"), audio = join(directory, "narration.wav");
    await writeFile(source, bytes, {flag: "wx"});
    const probe = JSON.parse(await command("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe",
      "-show_entries", "format=duration:stream=codec_type,duration", "-of", "json", source], signal));
    const streams = Array.isArray(probe.streams) ? probe.streams : [];
    let duration = Number(probe.format?.duration ?? streams.find((s: {duration?: string}) => s.duration)?.duration);
    // Browser WebM commonly omits container duration. Read bounded packet
    // timestamps instead of rejecting every genuine MediaRecorder segment.
    if (!Number.isFinite(duration)) {
      const packets = JSON.parse(await command("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe",
        "-read_intervals", "%+16", "-show_packets", "-show_entries", "packet=pts_time,duration_time",
        "-of", "json", source], signal));
      let start = Infinity, end = -Infinity;
      for (const packet of packets.packets ?? []) {
        const timestamp = Number(packet.pts_time), length = Number(packet.duration_time ?? 0);
        if (!Number.isFinite(timestamp) || !Number.isFinite(length) || length < 0) continue;
        // Packet order may interleave tracks, but extreme timestamp jumps are
        // not a trustworthy bounded foreground segment.
        requireThat(timestamp >= -1 && timestamp <= RECORDING_LIMITS.segmentSeconds + 1,
          "Recording timestamps exceed segment limits", 400);
        start = Math.min(start, timestamp); end = Math.max(end, timestamp + length);
      }
      duration = end - start;
    }
    requireThat(Number.isFinite(duration) && duration > 0 && duration <= RECORDING_LIMITS.segmentSeconds &&
      duration <= maximumSeconds + 0.25, "Recording duration could not be verified within its receipt", 400);
    requireThat(streams.some((s: {codec_type?: string}) => s.codec_type === "audio"), "No narration track available; review footage manually", 400);
    await command("ffmpeg", ["-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe",
      "-threads", "1", "-i", source, "-map", "0:a:0", "-vn", "-t", String(duration),
      "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-fs", "600000", audio], signal);
    const narration = await readFile(audio);
    requireThat(narration.length > 44 && narration.length <= 600000, "Narration could not be prepared", 400);
    return {narration, durationSeconds: duration};
  } finally {await rm(directory, {recursive: true, force: true});}
}

/** A separate derivative, never the original container. Audio and metadata are
 * removed before these bytes may become eligible for explicit customer release. */
export async function prepareSilentRecordingClip(bytes: Buffer, startSeconds: number, endSeconds: number, signal: AbortSignal) {
  requireThat(bytes.length > 0 && bytes.length <= RECORDING_LIMITS.segmentBytes &&
    Number.isFinite(startSeconds) && Number.isFinite(endSeconds) && startSeconds >= 0 &&
    endSeconds > startSeconds && endSeconds <= RECORDING_LIMITS.segmentSeconds, "Invalid selected clip range", 400);
  const directory = await mkdtemp(join(tmpdir(), "dvi-silent-clip-"));
  try {
    const source = join(directory, "source"), output = join(directory, "silent.mp4");
    await writeFile(source, bytes, {flag: "wx"});
    await command("ffmpeg", ["-nostdin", "-v", "error", "-protocol_whitelist", "file,pipe",
      "-threads", "1", "-i", source, "-ss", String(startSeconds), "-t", String(endSeconds - startSeconds),
      "-map", "0:v:0", "-an", "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1",
      "-vf", "scale=640:480:force_original_aspect_ratio=decrease:force_divisible_by=2",
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-b:v", "500k",
      "-threads", "1", "-movflags", "+faststart", "-fs", String(RECORDING_LIMITS.segmentBytes), output], signal);
    const probe = JSON.parse(await command("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe",
      "-show_entries", "format=duration:stream=codec_type", "-of", "json", output], signal));
    const streams = probe.streams ?? [], duration = Number(probe.format?.duration);
    requireThat(streams.length === 1 && streams[0].codec_type === "video" &&
      Number.isFinite(duration) && duration > 0 && duration <= endSeconds - startSeconds + 0.25,
      "Silent clip verification failed", 409);
    const silent = await readFile(output);
    requireThat(silent.length > 0 && silent.length < RECORDING_LIMITS.segmentBytes, "Silent clip exceeds media limits", 413);
    return {bytes: silent, mime: "video/mp4" as const, durationSeconds: duration};
  } finally {await rm(directory, {recursive: true, force: true});}
}
