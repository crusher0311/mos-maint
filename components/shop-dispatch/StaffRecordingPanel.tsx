"use client";

import {useEffect, useRef, useState} from "react";
import {blankFinding, type FindingInput, type StaffInspection} from "@/lib/auto-dvi/staff/model";
import type {RecordingSegment} from "@/lib/auto-dvi/staff/recording-model";
import {recordingDigest, useStaffRecording, type RecordingMode} from "./use-staff-recording";
import styles from "./pilot.module.css";
import ui from "./StaffInspectionPanel.module.css";
import recordingUi from "./StaffRecordingPanel.module.css";
import clipUi from "./SilentClips.module.css";
import {PreparedClipPreview} from "./PreparedClipPreview";

type Candidate = RecordingSegment["drafts"][number];
type RowDraft = {notes: string; caption: string; rating: Candidate["rating"]; disposition?: "applied" | "dismissed"};
type ClipDraft = {start: string; end: string; caption: string; confirmed: boolean};
export type StaffRecordingPanelProps = {
  visitId: string; inspection: StaffInspection; disabled: boolean;
  onDraft: (sheet: string, item: string, finding: FindingInput) => void;
  onLockChange?: (locked: boolean) => void;
};

/** The visit inspection owns parent drafts and their explicit evidence saves. */
export function StaffRecordingPanel(props: StaffRecordingPanelProps) {
  return <RecordingEditor key={props.visitId} {...props} />;
}
function RecordingEditor({visitId, inspection, disabled, onDraft, onLockChange}: StaffRecordingPanelProps) {
  const api = useStaffRecording(visitId, inspection.revision, disabled);
  const [mode, setMode] = useState<RecordingMode>("short");
  const [kind, setKind] = useState<"video" | "audio">("video");
  const [rows, setRows] = useState<Record<string, RowDraft>>({});
  const [clipRows, setClipRows] = useState<Record<string, ClipDraft>>({});
  const [hashes, setHashes] = useState<Record<string, string>>({});
  const lockCallback = useRef(onLockChange);
  lockCallback.current = onLockChange;
  const segments = api.recording?.segments ?? [];
  const candidates = segments.filter(segment => segment.state === "processed").flatMap(segment =>
    segment.drafts.map(candidate => ({candidate, segment, key: JSON.stringify([api.recording!.id, segment.sequence, candidate.id])})));
  const reviewing = candidates.filter(row => !rows[row.key]?.disposition).length;
  const active = api.captureState === "recording" || api.captureState === "saving-segment";
   const locked = api.loading || api.mismatch || api.busy || active || !!api.pendingClip ||
     !!api.recording?.clips?.some(clip => clip.state === "queued" || clip.state === "processing") || api.pending > 0 || reviewing > 0 ||
    (api.hasIdentity && (!api.recording || api.recording.state === "open")) ||
    segments.some(segment => segment.state === "uploaded" || segment.state === "processing");
  useEffect(() => {
    lockCallback.current?.(locked);
    return () => lockCallback.current?.(false);
  }, [locked]);
  useEffect(() => {
    if (!locked) return;
    const warn = (event: BeforeUnloadEvent) => {event.preventDefault(); event.returnValue = "";};
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [locked]);
  useEffect(() => {
    let current = true;
    // Same JSON byte representation used by the server's definition digest.
    void Promise.all(inspection.sheets.filter(sheet => sheet.active).flatMap(sheet =>
      sheet.sheet.items.map(async item => [
        JSON.stringify([sheet.key, item.id]), await recordingDigest(new Blob([JSON.stringify(item)])),
      ] as const))).then(entries => {if (current) setHashes(Object.fromEntries(entries));})
      .catch(() => {if (current) setHashes({});});
    return () => {current = false;};
  }, [inspection]);
  const controlsDisabled = disabled || api.mismatch;
  const processing = segments.filter(segment => segment.state === "uploaded" || segment.state === "processing").length;
  const failed = segments.filter(segment => segment.state === "failed").length;
  function edit(key: string, candidate: Candidate, patch: Partial<RowDraft>) {
    setRows(previous => ({...previous, [key]: {
      ...(previous[key] ?? {notes: candidate.notes, caption: candidate.caption, rating: candidate.rating}), ...patch,
    }}));
  }
  return <section className={`${styles.panel} ${recordingUi.panel}`} aria-label="Visit recording and narration review" data-testid="staff-recording-panel">
    <div className={ui.heading}>
      <div><div className={styles.eyebrow}>Internal only · Visit narration</div>
        <h3>Record now. Review before saving.</h3>
        <p>Narrate your observations beside the vehicle. Recording uploads and finding drafts are separate from saved inspection evidence.</p>
      </div>
      <span className={styles.chip}>{reviewing} draft finding{reviewing === 1 ? "" : "s"} to review</span>
    </div>
    <div className={styles.form}>
      <fieldset className={recordingUi.controls} disabled={controlsDisabled || api.hasIdentity || api.busy || api.loading}>
        <legend>Foreground capture</legend>
        <label>Recording length<select value={mode} onChange={event => setMode(event.target.value as RecordingMode)}>
          <option value="short">Short · one segment, about 10 seconds</option>
          <option value="continuous">Continuous · up to 30 independent segments</option>
        </select></label>
        <label>Capture source<select value={kind} onChange={event => setKind(event.target.value as "audio" | "video")}>
          <option value="video">Camera and narration</option><option value="audio">Narration only</option>
        </select></label>
      </fieldset>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} disabled={controlsDisabled || api.hasIdentity || api.busy || api.loading}
          onClick={() => void api.start(mode, kind)}>Start {mode === "short" ? "short" : "continuous"} recording</button>
        <button type="button" disabled={controlsDisabled || !api.hasIdentity || api.recording?.state === "stopped"}
          onClick={api.stop}>Stop capture · finish pending uploads</button>
        <button type="button" disabled={controlsDisabled || !api.hasIdentity || api.busy || api.loading}
          onClick={() => void api.recover()}>Recover pending uploads / check status</button>
      </div>
    </div>
    {api.loading && <div className={styles.skeleton} role="status" aria-label="Recovering recording identity and receipts" />}
    <div className={styles.brandingInfo} role="status" aria-live="polite">
      <strong>{active ? api.captureState === "saving-segment" ? "Saving segment on this device" : "Recording · keep this screen visible" :
        api.interrupted ? "Capture interrupted · recovery retained" :
        api.pending ? "Pending uploads · not server saved" :
        api.recording?.state === "stopped" ? "Recording stopped · server confirmed" :
        api.hasIdentity ? "Recording recovery / pending closure" : "Ready to record"}</strong>
      <p>{api.status}</p>
      <small>{api.pending} on-device pending upload(s) · {segments.length} server-confirmed segment(s) · {processing} processing · {failed} processing failed</small>
      {(failed > 0 || api.recording?.clips?.some(clip => clip.state === "failed")) && <p><button type="button"
        disabled={controlsDisabled || api.busy || api.captureState === "recording" || api.captureState === "saving-segment"}
        onClick={() => void api.retryProcessing()}>Retry failed processing</button><small> Maximum three attempts per segment or clip. Original footage stays private.</small></p>}
      {api.interrupted && <p><small>Capture did not continue in the background. The final moments may be unavailable. If capture never reports stopped, reload this tab and recover retained uploads before closing the recording.</small></p>}
      {!!segments.length && <p><small>“Server-confirmed” refers to recording media only. No item finding has been saved by this panel.</small></p>}
    </div>
    {api.error && <div className={styles.error} role="alert"><strong>Recovery needs attention</strong><p>{api.error}</p>
      {api.hasIdentity && !api.recording && <button type="button" disabled={controlsDisabled || api.busy || api.loading}
        onClick={() => void api.retryAdmission()}>Retry original admission · do not reopen camera</button>}
    </div>}
    {api.pendingClip && <div className={styles.notice} role="status"><strong>Clip request retained · selection locked</strong>
      <p>{api.pendingClip.caption} · {api.pendingClip.startSeconds}–{api.pendingClip.endSeconds}s. Retry uses the original clip identity and exact reviewed selection.</p>
      <button type="button" disabled={controlsDisabled || api.busy || api.loading} onClick={() => void api.retryClip()}>Retry exact retained clip request</button>
    </div>}
    {disabled && <p className={styles.notice}>Recording controls are unavailable while the inspection is locked. Available footage is retained, not discarded.</p>}
    <p><small>Maximum 30 segments, 4 MiB each. Independent segments have brief gaps. Keep this screen open and the phone unlocked: locked-screen and background recording are not supported. Device storage can fail or be cleared; this is not a full offline recording promise. Reload recovery uses this tab’s recording identity. Do not close the tab or clear browser storage while uploads are pending.</small></p>
    <h4>Narration drafts · {candidates.length} from processed segments</h4>
    <p><small>Source ranges identify the containing segment, not precise AI timing. Review a video range and customer caption explicitly to prepare a silent clip. Preparing is not publishing or saving finding evidence.</small></p>
    {!candidates.length && <div className={styles.empty}>
      <strong>{processing ? "Segments received. Narration review is processing." : "No narration drafts to review yet."}</strong>
      <p>{failed ? "Some segments could not be processed. Their server-confirmed media remains retained; use manual item findings. This panel has no processing-retry endpoint." : "Processed narration appears here for inline editing. Nothing is automatically applied or saved."}</p>
    </div>}
    {segments.map(segment => <details key={segment.sequence}>
      <summary>Segment {segment.sequence + 1} · 0–{segment.durationSeconds.toFixed(1)}s · {segment.state}</summary>
      <p><small>Server-confirmed upload · {segment.bytes.toLocaleString()} bytes · {segment.drafts.length} candidate(s)</small></p>
      {segment.error && <p className={styles.error}>{segment.error} · Enter findings manually; footage is not discarded.</p>}
    </details>)}
    {candidates.map(({candidate, segment, key}) => {
      const row = rows[key] ?? {notes: candidate.notes, caption: candidate.caption, rating: candidate.rating};
      const target = candidate.target;
      const admitted = target && api.recording?.targets.some(value =>
        value.sheet === target.sheet && value.item === target.item && value.definitionHash === target.definitionHash);
      const sheet = target && inspection.sheets.find(value => value.key === target.sheet && value.active);
      const item = sheet && sheet.sheet.items.find(value => value.id === target?.item);
      const matched = !!target && !!admitted && !!item &&
        hashes[JSON.stringify([target.sheet, target.item])] === target.definitionHash;
      const saved = target && sheet ? sheet.results[target.item] : undefined;
      const combinedNotes = [saved?.notes, row.notes, row.caption ? `Narration caption: ${row.caption}` : ""].filter(Boolean).join("\n");
      const tooLong = combinedNotes.length > 2000;
      const clipRow = clipRows[key] ?? {start: String(candidate.startSeconds), end: String(candidate.endSeconds), caption: candidate.caption, confirmed: false};
      const start = Number(clipRow.start), end = Number(clipRow.end);
      const validClip = clipRow.start.trim() !== "" && clipRow.end.trim() !== "" && Number.isFinite(start) && Number.isFinite(end) &&
        start >= 0 && end > start && end <= segment.durationSeconds && !!clipRow.caption.trim() && clipRow.caption.trim().length <= 2000;
      const editClip = (patch: Partial<ClipDraft>) => setClipRows(previous => ({...previous, [key]: {...clipRow, ...patch}}));
      const clips = api.recording?.clips?.filter(clip => clip.sequence === segment.sequence && clip.draftId === candidate.id) ?? [];
      return <article className={ui.item} key={key}>
        <h4>{matched ? `${sheet!.sheet.name} · ${item!.name}` : "Unmatched target · nothing will be applied"}</h4>
        <p><small>Source: narration · Segment {segment.sequence + 1}, range 0–{segment.durationSeconds.toFixed(1)}s.
          This is a segment range, not precise AI timing.</small></p>
        {!matched && <p className={styles.notice}>{target ? `Suggested target: ${target.name}. Its active visit item or definition no longer matches the admitted recording target.` : "No unambiguous visit item was identified."} Retain as reference and document the correct item manually.</p>}
        <fieldset disabled={controlsDisabled || !!row.disposition}>
          <legend>Review this observation · unsaved</legend>
          <div className={styles.form}>
            <label>Rating<select value={row.rating ?? ""} onChange={event => edit(key, candidate, {rating: (event.target.value || null) as Candidate["rating"]})}>
              <option value="">Not evaluated</option><option value="green">Green · satisfactory</option>
              <option value="yellow">Yellow · attention</option><option value="red">Red · urgent</option>
            </select></label>
            <label>Narration notes<textarea rows={3} maxLength={2000} value={row.notes} onChange={event => edit(key, candidate, {notes: event.target.value})} /></label>
            <label>Caption · included in item notes<textarea rows={2} maxLength={2000} value={row.caption} onChange={event => edit(key, candidate, {caption: event.target.value})} /></label>
          </div>
        </fieldset>
        {tooLong && <p className={styles.error}>Combined saved notes, narration and caption exceed 2,000 characters. Shorten this draft; existing saved notes will not be truncated.</p>}
        <p><small>Apply explicitly replaces any unsaved draft for this item. Saved measurements, N/A reason and recommendation are preserved; saved notes are kept and narration is appended. Review in the item editor, then save evidence there.</small></p>
        <div className={styles.actions}>
          <button type="button" disabled={controlsDisabled || !matched || tooLong || !!row.disposition} onClick={() => {
            if (!target || !matched) return;
            const base = saved ? {rating: saved.rating, notes: saved.notes, recommendation: saved.recommendation,
              naReason: saved.naReason, values: {...saved.values}} : blankFinding();
            onDraft(target.sheet, target.item, {...base, rating: row.rating, notes: combinedNotes});
            edit(key, candidate, {disposition: "applied"});
          }}>Apply / replace unsaved item draft</button>
          <button type="button" disabled={controlsDisabled || !!row.disposition}
            onClick={() => edit(key, candidate, {disposition: "dismissed"})}>Dismiss from this review</button>
        </div>
        {row.disposition && <p role="status">{row.disposition === "applied" ? "Applied to the unsaved item draft. Not saved evidence." : "Dismissed in this tab only. Server narration and media are unchanged."}</p>}
        {matched && segment.mime.startsWith("video/") && <div className={clipUi.editor}>
          <fieldset disabled={controlsDisabled || api.busy || active || !!api.pendingClip}>
            <legend>Customer silent clip · explicit review</legend>
            <p>Select seconds within this segment. These are suggested narration timestamps, not verified visual timing. Review the prepared result before release.</p>
            <div className={clipUi.range}>
              <label>Clip start (seconds)<input type="number" min="0" max={segment.durationSeconds} step="0.1" value={clipRow.start}
                onChange={event => editClip({start: event.target.value, confirmed: false})} /></label>
              <label>Clip end (seconds)<input type="number" min="0" max={segment.durationSeconds} step="0.1" value={clipRow.end}
                onChange={event => editClip({end: event.target.value, confirmed: false})} /></label>
            </div>
            <label>Reviewed customer caption<textarea rows={3} maxLength={2000} value={clipRow.caption}
              onChange={event => editClip({caption: event.target.value, confirmed: false})} /></label>
            <label className={clipUi.check}><input type="checkbox" checked={clipRow.confirmed}
              onChange={event => editClip({confirmed: event.target.checked})} />I reviewed this range and caption for this matched finding.</label>
            {!validClip && <p>Select an ordered range within 0–{segment.durationSeconds.toFixed(1)}s and a non-empty caption.</p>}
            <button type="button" disabled={!validClip || !clipRow.confirmed} onClick={() => {
              void api.prepareClip({sequence: segment.sequence, draftId: candidate.id, startSeconds: start, endSeconds: end,
                caption: clipRow.caption.trim(), confirmCaptionAndSelection: true});
              editClip({confirmed: false});
            }}>Prepare selected silent clip</button>
          </fieldset>
          <p><small>The backend removes the audio track from prepared media. Muting a source recording is not a silent customer clip. Only an advisor’s explicit release can share it.</small></p>
        </div>}
        {!segment.mime.startsWith("video/") && <p><small>Narration-only segment. Audio-only recordings cannot prepare customer clips.</small></p>}
        {clips.map(clip => <div key={clip.id}>
          <p role="status">Silent clip · {clip.state} · {clip.startSeconds}–{clip.endSeconds}s</p>
          {clip.state === "ready" && clip.mediaId ? <PreparedClipPreview visitId={visitId} recordingId={api.recording!.id}
            mediaId={clip.mediaId} caption={clip.caption} /> : <p>{clip.caption}</p>}
          {clip.state === "failed" && <p className={styles.notice}>Preparation failed. Original footage is retained. Review your selection and explicitly prepare a new clip, or use text and photos.</p>}
        </div>)}
      </article>;
    })}
    {api.recording && <>
      <p><small>Recording {api.recording.id} · {api.recording.state}. Review edits stay in memory on this page; they are not restored after reload. Finish review explicitly before preparing another recording.</small></p>
      <button type="button" disabled={controlsDisabled || locked || api.recording.state !== "stopped"}
        onClick={() => void api.finish()}>Finish this review · prepare another recording</button>
    </>}
  </section>;
}
