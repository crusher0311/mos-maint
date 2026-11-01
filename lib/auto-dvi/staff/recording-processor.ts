import {createHash} from "node:crypto";
import {enforceAiBudget} from "../../ai-budget";
import {extractVoiceFindings} from "../voice";
import {prepareRecordingContainer} from "./recording-container";
import type {RecordingProcessor} from "./recording-worker";
import {requireThat} from "../../shop-dispatch/model";

/** No vision model: suggestions originate only in narrated speech. A segment
 * timestamp identifies supporting footage, not a precisely localized diagnosis.
 * Technicians still review captions and observations before saving evidence. */
export const narrationRecordingProcessor: RecordingProcessor = {
  async process(input) {
    input.signal.throwIfAborted();
    const prepared = await prepareRecordingContainer(input.bytes, input.maximumSeconds, input.signal);
    input.signal.throwIfAborted();
    const denied = await enforceAiBudget({shopId: input.shopId, route: "/api/shop-dispatch/inspection/recordings", failClosed: true});
    requireThat(!denied, "Inspection assistance budget unavailable", 429);
    input.signal.throwIfAborted();
    const result = await extractVoiceFindings(input.shopId, prepared.narration, "audio/wav",
      input.targets.map(target => ({itemId: `${target.sheet}/${target.item}`, name: target.name})), input.signal);
    requireThat(result.ok, "Narration could not be processed; retain original recording", 502);
    const seen = new Set<string>();
    const drafts = (result.findings ?? []).flatMap(finding => {
      const matches = input.targets.filter(t => `${t.sheet}/${t.item}` === finding.itemId);
      const target = matches.length === 1 ? matches[0] : null;
      const notes = (finding.notes ?? "").slice(0, 2000);
      const id = createHash("sha256").update(JSON.stringify([input.sequence, finding.itemId, notes, finding.rating])).digest("hex");
      if (seen.has(id)) return [];
      seen.add(id);
      return [{id, target, source: "narration" as const, rating: finding.rating,
        notes, caption: notes, startSeconds: 0, endSeconds: Math.min(prepared.durationSeconds, input.maximumSeconds), confirmed: false as const}];
    }).slice(0, 30);
    return {drafts};
  },
};
