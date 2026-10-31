import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {prepareRecordingContainer, prepareSilentRecordingClip} from "../lib/auto-dvi/staff/recording-container";
import {mkdtemp, writeFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
test("local codec processing validates tracks/duration and extracts bounded narration without network", async () => {
  const bytes = execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i",
    "sine=frequency=440:sample_rate=16000", "-t", "1", "-c:a", "libopus", "-f", "webm", "pipe:1"]);
  // Pipe-written WebM models MediaRecorder's missing container duration.
  const webm = await prepareRecordingContainer(bytes, 2, new AbortController().signal);
  assert.ok(webm.narration.length <= 600000);
  assert.ok(webm.durationSeconds <= 2);
  const wav = execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i",
    "sine=frequency=440:sample_rate=16000", "-t", "1", "-c:a", "pcm_s16le", "-f", "wav", "pipe:1"]);
  const result = await prepareRecordingContainer(wav, 2, new AbortController().signal);
  assert.ok(result.narration.length > 44);
  assert.ok(result.durationSeconds <= 2);
  await assert.rejects(prepareRecordingContainer(wav, 0.1, new AbortController().signal), /duration/);
  await assert.rejects(prepareRecordingContainer(Buffer.from("not a recording"), 1, new AbortController().signal));
});
test("customer derivative physically removes audio and limits selected time range", async () => {
  const source = execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i",
    "color=c=blue:s=320x240:r=15", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000",
    "-t", "2", "-c:v", "libvpx", "-threads", "1", "-c:a", "libopus", "-f", "webm", "pipe:1"]);
  const clip = await prepareSilentRecordingClip(source, 0.5, 1.5, new AbortController().signal);
  assert.equal(clip.mime, "video/mp4");
  assert.ok(clip.durationSeconds <= 1.25);
  const directory = await mkdtemp(join(tmpdir(), "verify-dvi-silent-"));
  try {
    const path = join(directory, "clip.mp4"); await writeFile(path, clip.bytes);
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "json", path], {encoding: "utf8"}));
    assert.deepEqual(probe.streams.map((s: any) => s.codec_type), ["video"]);
  } finally {await rm(directory, {recursive: true, force: true});}
  await assert.rejects(prepareSilentRecordingClip(source, 1, 0.5, new AbortController().signal), /range/);
});
