import {staffMemberAccess} from "./access";
import {staffDependencies} from "./runtime";
import {MongoRecordingPersistence, RecordingRepository} from "./recording-store";
import {RecordingMediaStorage} from "./recording-media";
import {narrationRecordingProcessor} from "./recording-processor";
import {processRecordingSegment} from "./recording-worker";
import {processRecordingClip} from "./recording-clip-worker";
import {prepareOneIntakeContext} from "./intake-preparation-worker";
import {getFeatureEntitlements} from "../../featureResolver";

/** Dedicated serial worker pass, only for explicitly supplied shop IDs.
 * No scheduler registration or activation is performed by importing this file. */
export async function dispatchRecordingPass(shopIds: number[]) {
  const persistence = new MongoRecordingPersistence();
  const repository = new RecordingRepository(persistence), media = new RecordingMediaStorage();
  let processed = 0, blocked = 0;
  for (const shopId of shopIds) {
    // Product access is the outer gate. Do not claim work or consume attempts
    // merely because an operator's worker list still includes a disabled shop.
    const entitlements = await getFeatureEntitlements(shopId);
    if (!entitlements.isFeatureEnabled("auto_dvi") || !entitlements.isFeatureEnabled("shop_workflow")) continue;
    // Optional context cannot starve recording receipts if its store is down.
    try {await prepareOneIntakeContext(shopId);} catch {/* Retry on a later bounded pass. */}
    const candidates = await persistence.pending(shopId, Date.now());
    for (const recording of candidates) {
      const segment = recording.segments.find(s => s.attempts < 3 &&
        (s.state === "uploaded" || (s.state === "processing" && s.lease && s.lease.until <= Date.now())));
      const clip = recording.clips?.find(c => c.attempts < 3 &&
        (c.state === "queued" || (c.state === "processing" && c.lease && c.lease.until <= Date.now())));
      if (!segment && !clip) continue;
      const deps = {repository, staff: {...staffDependencies,
        access: async () => {
          const access = await staffMemberAccess(shopId, recording.contributorEmail);
          if (access.actor !== recording.actor) throw Error("Recording contributor changed");
          return access;
        }}};
      try {
        if (segment) await processRecordingSegment({visitId: recording.visitId, id: recording.id}, segment.sequence,
          deps, media, narrationRecordingProcessor);
        else await processRecordingClip({visitId: recording.visitId, id: recording.id}, clip!.id, deps, media);
        processed++;
      } catch {
        blocked++;
        // Do not log identity, transcript, media, provider errors or emails.
        // Closed/revoked contexts retain their media and require staff recovery.
      }
      if (processed + blocked >= 10) return {processed, blocked};
    }
  }
  return {processed, blocked};
}
