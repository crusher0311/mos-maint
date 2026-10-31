"use client";

import {useEffect, useRef, useState} from "react";
import {ForegroundRecording, type ForegroundCaptureState} from "@/lib/auto-dvi/staff/foreground-recording";
import {RecordingOutbox} from "@/lib/auto-dvi/staff/recording-outbox";
import {recordingClipSchema, recordingSegmentSchema, recordingTargetSchema} from "@/lib/auto-dvi/staff/recording-model";
import {z} from "zod";
import type {Recording} from "@/lib/auto-dvi/staff/recording-store";

type PublicRecording = Omit<Recording, "contributorEmail">;
type Identity = {
  id: string; visitId: string; inspectionRevision: number;
  shopId?: number; actor?: string; identityDigest?: string; scope?: string;
};
export type RecordingMode = "short" | "continuous";
export async function recordingDigest(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
const storageKey = (visitId: string) => `mos:staff-recording:${visitId}`;
const endpoint = "/api/shop-dispatch/inspection/recordings";
const clipRequestSchema = z.object({
  action: z.literal("clip"), visitId: z.string().min(1), id: z.string().uuid(), clipId: z.string().uuid(),
  sequence: z.number().int().min(0).max(29), draftId: z.string().min(1).max(100),
  startSeconds: z.number().finite().min(0), endSeconds: z.number().finite().positive().max(15),
  caption: z.string().trim().min(1).max(2000), confirmCaptionAndSelection: z.literal(true),
}).strict().refine(value => value.endSeconds > value.startSeconds);
type ClipRequest = z.infer<typeof clipRequestSchema>;
export type ClipSelection = Pick<ClipRequest, "sequence" | "draftId" | "startSeconds" | "endSeconds" | "caption" | "confirmCaptionAndSelection">;
const messageOf = (cause: unknown) => cause instanceof Error ? cause.message : "Recording request failed. Retained footage has not been discarded.";
// A replacement panel in the same document must not close a server recording
// ahead of the old panel's final asynchronous MediaRecorder/IDB callback.
const unsettledCaptures = new Set<string>();

/** No raw media leaves RecordingOutbox except the exact acknowledged upload. */
export function useStaffRecording(visitId: string, inspectionRevision: number, disabled: boolean) {
  const [recording, setRecording] = useState<PublicRecording | null>(null);
  const [pending, setPending] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [hasIdentity, setHasIdentity] = useState(false);
  const [mismatch, setMismatch] = useState(false);
  const [interrupted, setInterrupted] = useState(false);
  const [captureState, setCaptureState] = useState<ForegroundCaptureState>("stopped");
  const [status, setStatus] = useState("Ready for foreground narration.");
  const [error, setError] = useState("");
  const [pendingClip, setPendingClip] = useState<ClipRequest | null>(null);
  const runtime = useRef<{
    start(mode: RecordingMode, kind: "audio" | "video"): Promise<void>;
    recover(): Promise<void>; retryAdmission(): Promise<void>; stop(): void; finish(): Promise<void>;
    prepareClip(selection: ClipSelection): Promise<void>; retryClip(): Promise<void>; retryProcessing(): Promise<void>;
  } | null>(null);
  const options = useRef({disabled, inspectionRevision});
  options.current = {disabled, inspectionRevision};

  useEffect(() => {
    let alive = true, blocked = false, paused = false, requestBusy = false, pumping = false;
    let capturing = false, starting = false, persisting = 0, wantsStop = false, pendingCount = 0;
    let identity: Identity | null = null, latest: PublicRecording | null = null;
    let uncertainClip: ClipRequest | null = null;
    const clipKey = `${storageKey(visitId)}:clip`;
    let controller: AbortController | null = null, capture: ForegroundRecording | null = null;
    const outbox = new RecordingOutbox();
    const allowed = () => alive && !options.current.disabled && !blocked;
    const updateStatus = (value: string) => {if (alive) setStatus(value);};
    const report = (cause: unknown) => {
      paused = true;
      if (alive) setError(messageOf(cause));
    };
    function remember(value: Identity) {
      // Fail closed before camera access if recovery identity cannot be retained.
      sessionStorage.setItem(storageKey(visitId), JSON.stringify(value));
      identity = value;
      if (alive) setHasIdentity(true);
    }
    function identityFailure(): never {
      blocked = true; wantsStop = true; capture?.stop(true);
      if (alive) setMismatch(true);
      throw Error("Recording identity mismatch. Controls are locked; device footage is retained. Restore the original visit and contributor before recovery.");
    }
    function accept(payload: unknown): PublicRecording {
      if (!alive) throw Error("Recording response arrived after this panel closed. Recover its receipt on return.");
      if (!payload || typeof payload !== "object" || !identity) return identityFailure();
      const {recording: raw, scope} = payload as {recording?: PublicRecording; scope?: string};
      if (!raw || raw.id !== identity.id || raw.visitId !== visitId ||
        raw.inspectionRevision !== identity.inspectionRevision ||
        !Number.isInteger(raw.shopId) || raw.shopId <= 0 || typeof raw.actor !== "string" || !raw.actor ||
        !/^[a-f0-9]{64}$/.test(raw.identityDigest) ||
        scope !== JSON.stringify([raw.shopId, raw.actor, visitId]) ||
        (identity.scope && (scope !== identity.scope || raw.shopId !== identity.shopId ||
          raw.actor !== identity.actor || raw.identityDigest !== identity.identityDigest))) return identityFailure();
      if (!Array.isArray(raw.segments) || raw.segments.length > 30 ||
        !Array.isArray(raw.targets) || raw.targets.length > 200 ||
        !Number.isInteger(raw.revision) || raw.revision < 0 ||
        !["open", "stopped"].includes(raw.state)) return identityFailure();
      const segments = raw.segments.map(segment => recordingSegmentSchema.parse(segment));
      const targets = raw.targets.map(target => recordingTargetSchema.parse(target));
      const clips = raw.clips === undefined ? undefined : z.array(recordingClipSchema).max(90).parse(raw.clips);
      if (clips && (new Set(clips.map(clip => clip.id)).size !== clips.length || clips.some(clip => {
        const segment = segments.find(value => value.sequence === clip.sequence);
        const draft = segment?.drafts.find(value => value.id === clip.draftId);
        return !segment || !segment.mime.startsWith("video/") || !draft?.target ||
          JSON.stringify(draft.target) !== JSON.stringify(clip.target) || clip.endSeconds > segment.durationSeconds ||
          (clip.state === "ready" && (!clip.mediaId || !clip.durationSeconds));
      }))) return identityFailure();
      if (new Set(segments.map(segment => segment.sequence)).size !== segments.length) return identityFailure();
      remember({...identity, shopId: raw.shopId, actor: raw.actor, identityDigest: raw.identityDigest, scope});
      // GET and mutations share a single flight; still reject regressing receipts.
      if (latest && raw.revision < latest.revision) throw Error("Older recording receipt ignored. Recover the current server state.");
      latest = {...raw, segments, targets, ...(clips ? {clips} : {})};
      if (alive) setRecording(latest);
      return latest;
    }
    async function request(body?: FormData | Record<string, unknown>) {
      if (!allowed() || !identity) throw Error("Recording controls are unavailable. Footage is retained.");
      if (requestBusy) throw Error("A recording request is already awaiting acknowledgment.");
      requestBusy = true;
      const abort = new AbortController(); controller = abort;
      const timeout = setTimeout(() => abort.abort(), 20_000);
      try {
        const url = body ? endpoint : `${endpoint}?${new URLSearchParams({visitId, id: identity.id})}`;
        const response = await fetch(url, {
          method: body ? "POST" : "GET", credentials: "include", cache: "no-store", signal: abort.signal,
          ...(body ? body instanceof FormData ? {body} : {
            headers: {"Content-Type": "application/json"}, body: JSON.stringify(body),
          } : {}),
        });
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            wantsStop = true; capture?.stop(true);
          }
          throw Error(`Recording request not acknowledged (${response.status}). Device footage is retained; restore access and retry recovery.`);
        }
        return accept(await response.json());
      } finally {
        clearTimeout(timeout);
        requestBusy = false;
        if (controller === abort) controller = null;
      }
    }
    async function entries() {
      if (!identity?.scope) return [];
      const rows = (await outbox.list(identity.scope)).filter(row => row.recordingId === identity!.id);
      if (rows.some(row => row.visitId !== visitId || row.key !== JSON.stringify([identity!.scope, identity!.id, row.sequence]))) return identityFailure();
      pendingCount = rows.length;
      if (alive) setPending(rows.length);
      return rows;
    }
    async function pump() {
      if (!allowed() || paused || uncertainClip || pumping || requestBusy || !identity?.scope || !latest) return;
      pumping = true;
      if (alive) setBusy(true);
      try {
        let rows = await entries();
        while (rows.length && allowed() && !paused) {
          const row = rows[0];
          const digest = await recordingDigest(row.blob);
          if (!allowed()) break;
          const form = new FormData();
          form.set("visitId", visitId); form.set("id", identity.id);
          form.set("sequence", String(row.sequence)); form.set("durationSeconds", String(row.durationSeconds));
          form.set("mime", row.mime); form.set("file", row.blob, `segment-${row.sequence}`);
          updateStatus(`Uploading segment ${row.sequence + 1}. Original retained until the server confirms it.`);
          const receipt = await request(form);
          const exact = receipt.segments.find(segment => segment.sequence === row.sequence);
          if (!exact || exact.digest !== digest || exact.bytes !== row.blob.size ||
            exact.mime !== row.mime || exact.durationSeconds !== row.durationSeconds) {
            throw Error("Exact sequence and SHA-256 receipt missing. Original footage is retained for retry.");
          }
          // No local deletion on timeout, authorization failure, or a different receipt.
          await outbox.acknowledge(identity.scope, row.key);
          rows = await entries();
          updateStatus("Uploaded segment confirmed by the server. Finding drafts still require review and an explicit item save.");
        }
        // Capture's last asynchronous IndexedDB transaction must finish before Stop.
        if (allowed() && !paused && !rows.length && wantsStop && !capturing && !starting && !persisting &&
          !unsettledCaptures.has(identity.id) && latest?.state === "open") {
          await request({action: "stop", visitId, id: identity.id});
          updateStatus("Server confirmed recording stopped. Review narration drafts below; item evidence is not automatically saved.");
        }
      } catch (cause) {report(cause);}
      finally {pumping = false; if (alive) setBusy(false);}
    }
    async function recover(retryUploads = true) {
      if (!allowed() || requestBusy || pumping || !identity) return;
      if (retryUploads) paused = false;
      if (alive) {setBusy(true); if (retryUploads) setError("");}
      try {await request(); await entries();}
      catch (cause) {report(cause);}
      finally {if (alive) {setBusy(false); setLoading(false);}}
      if (!paused) await pump();
    }
    async function retryClip() {
      if (!allowed() || requestBusy || pumping || !uncertainClip) return;
      const pinned = uncertainClip;
      if (alive) {setBusy(true); setError("");}
      try {
        const receipt = await request(pinned);
        const clip = receipt.clips?.find(value => value.id === pinned.clipId);
        if (!clip || clip.sequence !== pinned.sequence || clip.draftId !== pinned.draftId ||
          clip.startSeconds !== pinned.startSeconds || clip.endSeconds !== pinned.endSeconds ||
          clip.caption !== pinned.caption) throw Error("Exact clip receipt missing. Retry the retained selection.");
        sessionStorage.removeItem(clipKey);
        uncertainClip = null; paused = false;
        if (alive) setPendingClip(null);
        updateStatus("Silent clip preparation requested. Nothing has been saved as finding evidence or published.");
      } catch (cause) {report(cause);}
      finally {if (alive) setBusy(false);}
    }
    async function prepareClip(selection: ClipSelection) {
      if (!allowed() || requestBusy || pumping || uncertainClip || capturing || starting || !identity || !latest) return;
      try {
        const pinned = clipRequestSchema.parse({...selection, action: "clip", visitId, id: identity.id, clipId: crypto.randomUUID()});
        const segment = latest.segments.find(value => value.sequence === pinned.sequence);
        if (!segment?.mime.startsWith("video/") || segment.state !== "processed" ||
          pinned.endSeconds > segment.durationSeconds || !segment.drafts.some(value => value.id === pinned.draftId && value.target))
          throw Error("Select a matched, processed video range. Audio-only recordings cannot prepare clips.");
        // Retain before sending, including across reload; corrections cannot replace an uncertain request.
        sessionStorage.setItem(clipKey, JSON.stringify(pinned));
        uncertainClip = pinned; setPendingClip(pinned);
        await retryClip();
      } catch (cause) {report(cause);}
    }
    async function admit() {
      if (!identity) throw Error("No pinned recording admission.");
      return request({action: "start", visitId, id: identity.id, inspectionRevision: identity.inspectionRevision});
    }
    async function start(mode: RecordingMode, kind: "audio" | "video") {
      if (!allowed() || starting || capturing || requestBusy || pumping || identity) return;
      starting = true; wantsStop = false; paused = false;
      if (alive) {setBusy(true); setError("");}
      try {
        remember({id: crypto.randomUUID(), visitId, inspectionRevision: options.current.inspectionRevision});
        await admit(); // Admission and recovery identity precede camera permission.
        if (!allowed() || wantsStop) return;
        const pin = {...identity!};
        if (!pin.scope) throw Error("Authorized recording scope missing.");
        capture = new ForegroundRecording({
          async persist(segment) {
            persisting++;
            try {
              await outbox.put({...segment, key: JSON.stringify([pin.scope, pin.id, segment.sequence]),
                scope: pin.scope!, recordingId: pin.id, visitId});
              // ForegroundRecording cannot continue until the put transaction commits.
              if (mode === "short" || !allowed()) {wantsStop = true; capture?.stop();}
              if (alive) {await entries(); void pump();}
            } catch (cause) {
              // A rejected put makes ForegroundRecording release its tracks.
              // This segment is not claimed retained or server-saved.
              capturing = false;
              unsettledCaptures.delete(pin.id);
              report(cause);
              throw cause;
            } finally {persisting--;}
          },
          state(value, message) {
            if (value === "recording" || value === "saving-segment") capturing = true;
            if (value === "stopped") {
              capturing = false; wantsStop = true; unsettledCaptures.delete(pin.id);
            }
            if (value === "interrupted") {
              // stop(true) may still be persisting its final available segment.
              wantsStop = true;
              if (alive) setInterrupted(true);
              updateStatus(message);
            }
            if (alive) {setCaptureState(value); updateStatus(message);}
            if (value === "stopped") void pump();
          },
        });
        capturing = true;
        unsettledCaptures.add(pin.id);
        await capture.start(kind);
      } catch (cause) {
        capturing = false; wantsStop = true; capture?.stop(true);
        const retainedIdentity = identity as Identity | null;
        if (retainedIdentity) unsettledCaptures.delete(retainedIdentity.id);
        report(cause);
      } finally {
        starting = false;
        if (alive) setBusy(false);
        void pump();
      }
    }
    function stop() {
      wantsStop = true;
      capture?.stop();
      // stop() during a storage gap emits no terminal callback; the pending
      // persist promise still emits stopped. With no capture, close via pump.
      if (!capture) capturing = false;
      void pump();
    }
    async function finish() {
      if (!allowed() || requestBusy || pumping || capturing || starting || persisting || uncertainClip ||
        latest?.clips?.some(clip => clip.state === "queued" || clip.state === "processing") ||
        latest?.state !== "stopped" || latest.segments.some(segment => segment.state === "processing" || segment.state === "uploaded")) return;
      try {
        if ((await entries()).length) throw Error("Resolve retained uploads before preparing another recording.");
        // Explicit review completion removes only the tab's identity pointer,
        // never recording media or server findings.
        sessionStorage.removeItem(storageKey(visitId));
        identity = null; latest = null; capture = null; wantsStop = false; paused = false;
        if (alive) {
          setRecording(null); setHasIdentity(false); setCaptureState("stopped");
          setInterrupted(false); setError("");
          updateStatus("Previous recording remains on the server. Ready for another foreground recording.");
        }
      } catch (cause) {report(cause);}
    }
    async function retryAdmission() {
      if (!allowed() || requestBusy || pumping || capturing || !identity || latest) return;
      paused = false;
      if (alive) {setBusy(true); setError("");}
      try {await admit(); wantsStop = true; await entries();}
      catch (cause) {report(cause);}
      finally {if (alive) setBusy(false);}
      if (!paused) await pump();
    }
    async function retryProcessing() {
      if (!allowed() || !identity || requestBusy || pumping || capturing || starting) return;
      if (alive) setBusy(true);
      try {await request({action: "retry-processing", visitId, id: identity.id});}
      catch (cause) {report(cause);}
      finally {if (alive) setBusy(false);}
    }
    runtime.current = {start, stop, recover, retryAdmission, finish, prepareClip, retryClip, retryProcessing};
    setRecording(null); setPending(0); setHasIdentity(false); setMismatch(false);
    setCaptureState("stopped"); setInterrupted(false); setLoading(true); setError(""); setPendingClip(null);
    try {
      const raw = sessionStorage.getItem(storageKey(visitId));
      if (raw) {
        const pin = JSON.parse(raw) as Identity;
        if (!pin || pin.visitId !== visitId || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(pin.id) ||
          !Number.isInteger(pin.inspectionRevision) || pin.inspectionRevision < 0 ||
          (pin.scope && pin.scope !== JSON.stringify([pin.shopId, pin.actor, visitId]))) return identityFailure();
        identity = pin; wantsStop = true; setHasIdentity(true);
        const retained = sessionStorage.getItem(clipKey);
        if (retained) {
          uncertainClip = clipRequestSchema.parse(JSON.parse(retained));
          if (uncertainClip.visitId !== visitId || uncertainClip.id !== pin.id) return identityFailure();
          setPendingClip(uncertainClip);
        }
        setInterrupted(true);
        updateStatus("Previous recording interrupted. Recovering server receipts and this contributor’s retained uploads; camera will not restart.");
        if (allowed()) void recover();
        else setLoading(false);
      } else {
        if (sessionStorage.getItem(clipKey)) return identityFailure();
        setLoading(false);
      }
    } catch (cause) {
      // An unreadable pointer must never be overwritten by a new admission.
      blocked = true; setMismatch(true);
      report(cause); setLoading(false);
    }
    const interval = setInterval(() => {
      if (allowed() && identity && !requestBusy && !pumping &&
        (!latest || latest.state === "open" || pendingCount ||
           latest.segments.some(segment => segment.state === "uploaded" || segment.state === "processing") ||
           latest.clips?.some(clip => clip.state === "queued" || clip.state === "processing"))) void recover(false);
    }, 3000);
    const online = () => {if (allowed()) void recover();};
    const beforeLeave = (event: BeforeUnloadEvent) => {
      if (identity && (latest?.state !== "stopped" || capturing || persisting || uncertainClip ||
        latest?.clips?.some(clip => clip.state === "queued" || clip.state === "processing"))) {
        event.preventDefault(); event.returnValue = "";
      }
    };
    window.addEventListener("online", online);
    window.addEventListener("beforeunload", beforeLeave);
    return () => {
      alive = false; wantsStop = true;
      clearInterval(interval); controller?.abort(); capture?.stop(true);
      window.removeEventListener("online", online);
      window.removeEventListener("beforeunload", beforeLeave);
      runtime.current = null;
      // Do not close IDB here: onstop may still commit its final segment.
      // Neither identity nor raw entries are discarded on unmount.
    };
  }, [visitId]);

  useEffect(() => {if (disabled) runtime.current?.stop();}, [disabled]);
  return {
    recording, pending, pendingClip, busy, loading, hasIdentity, mismatch, interrupted, captureState, status, error,
    prepareClip: (selection: ClipSelection) => runtime.current?.prepareClip(selection),
    retryProcessing: () => runtime.current?.retryProcessing(),
    retryClip: () => runtime.current?.retryClip(),
    start: (mode: RecordingMode, kind: "audio" | "video") => runtime.current?.start(mode, kind),
    stop: () => runtime.current?.stop(),
    recover: () => runtime.current?.recover(),
    retryAdmission: () => runtime.current?.retryAdmission(),
    finish: () => runtime.current?.finish(),
  };
}
