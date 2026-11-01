import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {appendRecordingSegment, claimRecordingSegment, finishRecordingSegment, RECORDING_LIMITS, type RecordingSegment} from "../lib/auto-dvi/staff/recording-model";
const segment = (sequence = 0): RecordingSegment => ({sequence, digest: "a".repeat(64), bytes: 100,
  mime: "video/webm", durationSeconds: 10, mediaId: "b".repeat(24), state: "uploaded",
  attempts: 0, lease: null, drafts: [], error: null});
test("ordered bounded receipt insertion rejects changed retries and forged results", () => {
  const first = appendRecordingSegment([], segment(1));
  assert.deepEqual(appendRecordingSegment(first, segment()).map(s => s.sequence), [0, 1]);
  assert.equal(appendRecordingSegment(first, segment(1)), first);
  assert.throws(() => appendRecordingSegment(first, {...segment(1), digest: "c".repeat(64)}), /original/);
  assert.throws(() => appendRecordingSegment([], {...segment(), bytes: RECORDING_LIMITS.segmentBytes + 1}));
  assert.throws(() => appendRecordingSegment([], {...segment(), state: "processed"}), /processing results/);
});
test("worker claims exclude concurrent work, fence expired results and bound retries", () => {
  const token = randomUUID();
  const first = claimRecordingSegment(segment(), token, 0);
  assert.throws(() => claimRecordingSegment(first, randomUUID(), 1), /already in progress/);
  assert.throws(() => finishRecordingSegment(first, token, RECORDING_LIMITS.leaseMs, {drafts: []}), /late output/);
  const nextToken = randomUUID();
  const second = claimRecordingSegment(first, nextToken, RECORDING_LIMITS.leaseMs);
  assert.throws(() => finishRecordingSegment(second, token, RECORDING_LIMITS.leaseMs + 1, {drafts: []}), /late output/);
  const failed = finishRecordingSegment(second, nextToken, RECORDING_LIMITS.leaseMs + 1, {error: "Try again"});
  const third = claimRecordingSegment(failed, randomUUID(), RECORDING_LIMITS.leaseMs + 2);
  assert.throws(() => claimRecordingSegment(third, randomUUID(), RECORDING_LIMITS.leaseMs * 3), /retry limit/);
});
test("silence yields no findings; visual or confirmed model output is rejected", () => {
  const token = randomUUID(), claimed = claimRecordingSegment(segment(), token, 0);
  const done = finishRecordingSegment(claimed, token, 1, {drafts: []});
  assert.deepEqual(done.drafts, []);
  assert.throws(() => claimRecordingSegment(done, randomUUID(), 2), /receipt/);
  const draft = {id: "one", target: null, source: "narration", rating: null, notes: "Check",
    caption: "Check", startSeconds: 0, endSeconds: 1, confirmed: false};
  assert.equal(finishRecordingSegment(claimed, token, 1, {drafts: [draft]}).drafts[0].confirmed, false);
  assert.throws(() => finishRecordingSegment(claimed, token, 1, {drafts: [{...draft, source: "visual"}]}));
  assert.throws(() => finishRecordingSegment(claimed, token, 1, {drafts: [{...draft, confirmed: true}]}));
  assert.throws(() => finishRecordingSegment(claimed, token, 1, {drafts: [{...draft, endSeconds: 11}]}), /footage/);
});
