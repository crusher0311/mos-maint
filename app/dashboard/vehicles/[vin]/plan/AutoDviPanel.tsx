"use client";

// Task #991 — Auto DVI: dashboard surface on the vehicle plan page. Lets a
// user generate the vehicle-specific inspection (VHI maintenance/inspect
// items + shop custom items with covered duplicates hidden), record
// per-item findings (green/yellow/red rating, notes, recommendation,
// photos/videos), and write it to the open RO as an "Inspection" package
// (Protractor only from the dashboard — Tekmetric writes need the
// extension's page session). Findings autosave to the server and ride in
// the WO package note; line titles stay "Inspected: …" for anchor safety.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ClipboardCheck,
  Loader2,
  ChevronDown,
  ChevronUp,
  EyeOff,
  Camera,
  Trash2,
  MessageSquarePlus,
  Mic,
  Square,
  Images,
  Sparkles,
} from "lucide-react";

type Rating = "green" | "yellow" | "red";

type ComposedItem = {
  id: string;
  name: string;
  lineTitle: string;
  source: "vhi" | "shop" | "recall";
  serviceKey: string | null;
  bucket?: string | null;
  group?: string | null;
  notes?: string | null;
  defaultRating?: "red" | "yellow" | null;
};

type HiddenItem = {
  item: { id: string; name: string };
  reason: string;
};

type MediaRef = {
  mediaId: string;
  kind: "photo" | "video";
  contentType: string;
  filename: string | null;
};

type Finding = {
  rating: Rating | null;
  notes: string;
  recommendation: string;
  media: MediaRef[];
};

const RATING_STYLES: Record<Rating, { on: string; off: string; label: string }> = {
  green: { on: "bg-green-600 text-white border-green-600", off: "bg-white text-green-700 border-green-300 hover:bg-green-50", label: "Good" },
  yellow: { on: "bg-yellow-500 text-white border-yellow-500", off: "bg-white text-yellow-700 border-yellow-300 hover:bg-yellow-50", label: "Monitor" },
  red: { on: "bg-red-600 text-white border-red-600", off: "bg-white text-red-700 border-red-300 hover:bg-red-50", label: "Attention" },
};

export default function AutoDviPanel({
  vin,
  mileage,
  isProtractor,
}: {
  vin: string;
  mileage: number | null;
  isProtractor: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [items, setItems] = useState<ComposedItem[] | null>(null);
  const [hidden, setHidden] = useState<HiddenItem[]>([]);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [findings, setFindings] = useState<Record<string, Finding>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [uploadingFor, setUploadingFor] = useState<string | null>(null);
  const [roNumber, setRoNumber] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [addRecommended, setAddRecommended] = useState(false);
  const [recording, setRecording] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceSummary, setVoiceSummary] = useState<string | null>(null);
  const [assignBusy, setAssignBusy] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaves = useRef<Map<string, { itemId: string; name: string }>>(new Map());
  const findingsRef = useRef(findings);
  findingsRef.current = findings;

  function emptyFinding(): Finding {
    return { rating: null, notes: "", recommendation: "", media: [] };
  }

  const getFinding = (id: string): Finding => findings[id] || emptyFinding();

  /** Debounced autosave of dirty items' findings. */
  const queueSave = useCallback(
    (itemId: string, name: string) => {
      pendingSaves.current.set(itemId, { itemId, name });
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        const dirty = Array.from(pendingSaves.current.values());
        pendingSaves.current.clear();
        if (dirty.length === 0) return;
        try {
          await fetch("/api/auto-dvi/results", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              vin,
              items: dirty.map((d) => {
                const f = findingsRef.current[d.itemId] || emptyFinding();
                return {
                  itemId: d.itemId,
                  name: d.name,
                  rating: f.rating,
                  notes: f.notes || null,
                  recommendation: f.recommendation || null,
                };
              }),
            }),
          });
        } catch {
          // autosave is best-effort; findings still ride along on push
        }
      }, 800);
    },
    [vin],
  );

  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
  }, []);

  function patchFinding(item: ComposedItem, patch: Partial<Finding>) {
    setFindings((prev) => ({ ...prev, [item.id]: { ...(prev[item.id] || emptyFinding()), ...patch } }));
    queueSave(item.id, item.name);
  }

  async function loadSavedResults() {
    try {
      const res = await fetch(`/api/auto-dvi/results?vin=${encodeURIComponent(vin)}`);
      if (!res.ok) return;
      const data = await res.json();
      const saved: Record<string, Finding> = {};
      for (const it of data?.results?.items || []) {
        saved[it.itemId] = {
          rating: it.rating || null,
          notes: it.notes || "",
          recommendation: it.recommendation || "",
          media: Array.isArray(it.media) ? it.media : [],
        };
      }
      if (Object.keys(saved).length > 0) setFindings((prev) => ({ ...saved, ...prev }));
    } catch {
      // best-effort
    }
  }

  async function generate() {
    setLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const [res] = await Promise.all([
        fetch("/api/auto-dvi/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ vin, mileage: mileage ?? undefined }),
        }),
        loadSavedResults(),
      ]);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Could not generate inspection");
      setItems(data.items || []);
      setHidden(data.hidden || []);
      const init: Record<string, boolean> = {};
      // Recalls are opt-in: the shop chooses whether to share them on the RO.
      for (const it of data.items || []) init[it.id] = it.source !== "recall";
      setChecked(init);
      // Prefill plan-suggested ratings (overdue → red, due soon → yellow)
      // for items with no saved finding, so the checklist starts in
      // agreement with the VHI instead of unrated/stale.
      setFindings((prev) => {
        const next = { ...prev };
        for (const it of data.items || []) {
          if (!it.defaultRating) continue;
          const existing = next[it.id];
          if (existing?.rating) continue;
          next[it.id] = { ...(existing || emptyFinding()), rating: it.defaultRating };
        }
        return next;
      });
    } catch (err: any) {
      setError(err.message || "Could not generate inspection");
    } finally {
      setLoading(false);
    }
  }

  async function uploadMedia(item: ComposedItem, file: File) {
    setUploadingFor(item.id);
    setError(null);
    try {
      const form = new FormData();
      form.append("vin", vin);
      form.append("itemId", item.id);
      form.append("itemName", item.name);
      form.append("file", file);
      const res = await fetch("/api/auto-dvi/media", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Upload failed");
      setFindings((prev) => {
        const f = prev[item.id] || emptyFinding();
        return { ...prev, [item.id]: { ...f, media: [...f.media, data.media] } };
      });
    } catch (err: any) {
      setError(err.message || "Upload failed");
    } finally {
      setUploadingFor(null);
    }
  }

  async function removeMedia(item: ComposedItem, mediaId: string) {
    try {
      const res = await fetch(`/api/auto-dvi/media/${mediaId}?vin=${encodeURIComponent(vin)}`, { method: "DELETE" });
      if (!res.ok) return;
      setFindings((prev) => {
        const f = prev[item.id] || emptyFinding();
        return { ...prev, [item.id]: { ...f, media: f.media.filter((m) => m.mediaId !== mediaId) } };
      });
    } catch {
      // best-effort
    }
  }

  /** Checklist payload for the voice / photo-assign AI endpoints. */
  function checklistPayload() {
    return (items || [])
      .filter((i) => i.source !== "recall")
      .map((i) => ({ itemId: i.id, name: i.name, serviceKey: i.serviceKey }));
  }

  /** Apply structured voice findings: patch matched items, append ad-hoc ones. */
  function applyVoiceFindings(findingsIn: any[], language: string | null) {
    let matched = 0;
    let added = 0;
    const newItems: ComposedItem[] = [];
    for (const f of findingsIn) {
      if (!f?.itemId) continue;
      const exists = (items || []).some((i) => i.id === f.itemId) || newItems.some((i) => i.id === f.itemId);
      if (!exists) {
        newItems.push({
          id: f.itemId,
          name: f.name,
          lineTitle: f.lineTitle || `Inspected: ${f.name}`,
          source: "shop",
          serviceKey: null,
          group: "Dictated",
        });
        added++;
      } else {
        matched++;
      }
      setFindings((prev) => {
        const cur = prev[f.itemId] || emptyFinding();
        return {
          ...prev,
          [f.itemId]: {
            ...cur,
            rating: f.rating ?? cur.rating,
            notes: f.notes ? (cur.notes ? `${cur.notes} ${f.notes}` : f.notes) : cur.notes,
            recommendation: f.recommendation || cur.recommendation,
          },
        };
      });
      queueSave(f.itemId, f.name);
      setChecked((prev) => ({ ...prev, [f.itemId]: true }));
    }
    if (newItems.length > 0) setItems((prev) => [...(prev || []), ...newItems]);
    setVoiceSummary(
      `Applied ${matched + added} finding${matched + added !== 1 ? "s" : ""}${added ? ` (${added} new item${added !== 1 ? "s" : ""})` : ""}${language && !/^en/i.test(language) ? ` — translated from ${language}` : ""}.`,
    );
  }

  async function startRecording() {
    setError(null);
    setVoiceSummary(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream, MediaRecorder.isTypeSupported("audio/webm") ? { mimeType: "audio/webm" } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        chunksRef.current = [];
        if (blob.size < 1000) return; // accidental tap
        setVoiceBusy(true);
        try {
          const form = new FormData();
          form.append("vin", vin);
          form.append("audio", new File([blob], "dictation.webm", { type: blob.type }));
          form.append("items", JSON.stringify(checklistPayload()));
          const res = await fetch("/api/auto-dvi/voice", { method: "POST", body: form });
          const data = await res.json();
          if (!res.ok || !data.ok) {
            throw new Error(
              data?.transcript
                ? `${data.error} — heard: “${String(data.transcript).slice(0, 200)}”`
                : data?.error || "Could not process the dictation",
            );
          }
          applyVoiceFindings(data.findings || [], data.language ?? null);
        } catch (err: any) {
          setError(err.message || "Could not process the dictation");
        } finally {
          setVoiceBusy(false);
        }
      };
      rec.start();
      recorderRef.current = rec;
      setRecording(true);
    } catch {
      setError("Microphone access was denied");
    }
  }

  function stopRecording() {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
  }

  /** Batch photos → AI assignment → upload each to its matched item. */
  async function autoAssignPhotos(files: File[]) {
    if (files.length === 0) return;
    setAssignBusy(true);
    setError(null);
    setVoiceSummary(null);
    try {
      const form = new FormData();
      form.append("items", JSON.stringify(checklistPayload()));
      for (const f of files.slice(0, 8)) form.append("photos", f);
      const res = await fetch("/api/auto-dvi/photo-assign", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data?.error || "Photo assignment failed");
      let attached = 0;
      const unmatched: string[] = [];
      for (const a of data.assignments || []) {
        const file = files[a.index];
        if (!file) continue;
        const item = (items || []).find((i) => i.id === a.itemId);
        if (item) {
          await uploadMedia(item, file);
          attached++;
        } else {
          unmatched.push(a.label || file.name);
        }
      }
      setVoiceSummary(
        `Attached ${attached} photo${attached !== 1 ? "s" : ""}${
          unmatched.length ? ` — ${unmatched.length} unassigned (${unmatched.slice(0, 3).join(", ")}${unmatched.length > 3 ? "…" : ""}): add manually` : ""
        }.`,
      );
    } catch (err: any) {
      setError(err.message || "Photo assignment failed");
    } finally {
      setAssignBusy(false);
    }
  }

  async function push() {
    if (!items) return;
    const selected = items.filter((i) => checked[i.id]);
    if (selected.length === 0) {
      setError("Select at least one item to write to the RO");
      return;
    }
    setPushing(true);
    setError(null);
    setSuccess(null);
    const recommendedItems = addRecommended
      ? selected
          .filter((i) => i.source === "vhi" && (i.bucket === "overdue" || i.bucket === "due_soon"))
          .map((i) => ({ name: i.name, serviceKey: i.serviceKey }))
      : [];
    try {
      const res = await fetch("/api/auto-dvi/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vin,
          roNumber: roNumber.trim() || undefined,
          items: selected.map((i) => {
            const f = getFinding(i.id);
            return {
              name: i.name,
              serviceKey: i.serviceKey,
              rating: f.rating,
              notes: f.notes || null,
              recommendation: f.recommendation || null,
              // Plan context — server auto-fills inspection line notes.
              source: i.source,
              bucket: i.bucket ?? null,
              action: (i as any).action ?? null,
              dueAtMiles: (i as any).dueAtMiles ?? null,
              milesToGo: (i as any).milesToGo ?? null,
              itemNotes: (i as any).notes ?? null,
            };
          }),
          recommendedItems: recommendedItems.length > 0 ? recommendedItems : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Could not write inspection to RO");
      setSuccess(
        `Inspection written to the work order (${data.lineCount} lines${
          data.recommendedCount ? `, plus ${data.recommendedCount} recommended-work package${data.recommendedCount !== 1 ? "s" : ""}` : ""
        })${data.inspectionResultsWritten ? " — findings also recorded in Protractor's inspection view" : ""}.`,
      );
    } catch (err: any) {
      setError(err.message || "Could not write inspection to RO");
    } finally {
      setPushing(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6 print:hidden">
      <div className="my-4 rounded-xl border border-blue-200 bg-blue-50/50">
        <button
          onClick={() => {
            setOpen(!open);
            if (!open && !items && !loading) generate();
          }}
          className="w-full flex items-center justify-between px-4 py-3 text-left"
        >
          <span className="flex items-center gap-2 font-semibold text-blue-900">
            <ClipboardCheck className="w-5 h-5" /> Auto DVI — Generate Vehicle Inspection
          </span>
          {open ? <ChevronUp className="w-4 h-4 text-blue-700" /> : <ChevronDown className="w-4 h-4 text-blue-700" />}
        </button>

        {open && (
          <div className="px-4 pb-4 space-y-3">
            {loading && (
              <div className="flex items-center gap-2 text-sm text-blue-800 py-4">
                <Loader2 className="w-4 h-4 animate-spin" /> Building this vehicle&apos;s inspection…
              </div>
            )}
            {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
            {success && <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2">{success}</div>}

            {items && !loading && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => (recording ? stopRecording() : startRecording())}
                    disabled={voiceBusy}
                    className={`inline-flex items-center gap-1.5 text-xs font-medium rounded-lg px-3 py-1.5 border ${
                      recording
                        ? "bg-red-600 text-white border-red-600 animate-pulse"
                        : "bg-white text-blue-700 border-blue-300 hover:bg-blue-50"
                    } disabled:opacity-50`}
                  >
                    {voiceBusy ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : recording ? (
                      <Square className="w-3.5 h-3.5" />
                    ) : (
                      <Mic className="w-3.5 h-3.5" />
                    )}
                    {recording ? "Stop & apply" : voiceBusy ? "Processing dictation…" : "Dictate findings"}
                  </button>
                  <label className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 border border-blue-300 rounded-lg px-3 py-1.5 cursor-pointer hover:bg-blue-50">
                    {assignBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Images className="w-3.5 h-3.5" />}
                    Auto-assign photos
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      multiple
                      className="hidden"
                      disabled={assignBusy}
                      onChange={(e) => {
                        const files = Array.from(e.target.files || []);
                        e.target.value = "";
                        autoAssignPhotos(files);
                      }}
                    />
                  </label>
                  <a
                    href={`/dashboard/vehicles/${encodeURIComponent(vin)}/inspect`}
                    className="inline-flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-900"
                  >
                    <Sparkles className="w-3.5 h-3.5" /> Phone mode
                  </a>
                  <span className="text-[11px] text-gray-500">
                    Speak the whole inspection in any language — items, ratings &amp; notes are built from the audio.
                  </span>
                </div>
                {voiceSummary && (
                  <div className="text-xs text-blue-800 bg-blue-100/60 border border-blue-200 rounded-lg px-3 py-1.5">
                    {voiceSummary}
                  </div>
                )}
                <ul className="divide-y divide-blue-100 bg-white rounded-lg border border-blue-100">
                  {items.filter((i) => i.source !== "recall").map((it) => {
                    const f = getFinding(it.id);
                    const isExpanded = !!expanded[it.id];
                    const hasDetail = !!(f.notes || f.recommendation || f.media.length > 0);
                    return (
                      <li key={it.id} className="px-3 py-2">
                        <div className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            className="mt-1"
                            checked={!!checked[it.id]}
                            onChange={(e) => setChecked({ ...checked, [it.id]: e.target.checked })}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="text-sm text-gray-900">{it.lineTitle}</div>
                            <div className="text-xs text-gray-500">
                              {it.source === "vhi"
                                ? `From maintenance plan${it.bucket ? ` (${String(it.bucket).replace("_", " ")})` : ""}`
                                : `Shop item${it.group ? ` — ${it.group}` : ""}`}
                              {it.notes ? ` · ${it.notes}` : ""}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            {(Object.keys(RATING_STYLES) as Rating[]).map((r) => (
                              <button
                                key={r}
                                title={RATING_STYLES[r].label}
                                onClick={() => patchFinding(it, { rating: f.rating === r ? null : r })}
                                className={`text-[10px] font-semibold border rounded-full px-2 py-0.5 transition-colors ${
                                  f.rating === r ? RATING_STYLES[r].on : RATING_STYLES[r].off
                                }`}
                              >
                                {RATING_STYLES[r].label}
                              </button>
                            ))}
                            <button
                              title="Notes, recommendation & photos"
                              onClick={() => setExpanded({ ...expanded, [it.id]: !isExpanded })}
                              className={`ml-1 p-1 rounded hover:bg-gray-100 ${hasDetail ? "text-blue-600" : "text-gray-400"}`}
                            >
                              <MessageSquarePlus className="w-4 h-4" />
                            </button>
                          </div>
                        </div>

                        {isExpanded && (
                          <div className="mt-2 ml-7 space-y-2">
                            <textarea
                              className="w-full border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs"
                              rows={2}
                              placeholder="Technician notes (condition found, measurements…)"
                              value={f.notes}
                              onChange={(e) => patchFinding(it, { notes: e.target.value })}
                            />
                            <textarea
                              className="w-full border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs"
                              rows={1}
                              placeholder="Recommendation (e.g. replace at next visit)"
                              value={f.recommendation}
                              onChange={(e) => patchFinding(it, { recommendation: e.target.value })}
                            />
                            <div className="flex flex-wrap items-center gap-2">
                              {f.media.map((m) => (
                                <div key={m.mediaId} className="relative group">
                                  {m.kind === "photo" ? (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img
                                      src={`/api/auto-dvi/media/${m.mediaId}`}
                                      alt={m.filename || "inspection photo"}
                                      className="w-16 h-16 object-cover rounded-lg border border-gray-200"
                                    />
                                  ) : (
                                    <video
                                      src={`/api/auto-dvi/media/${m.mediaId}`}
                                      className="w-24 h-16 object-cover rounded-lg border border-gray-200"
                                      controls
                                      preload="metadata"
                                    />
                                  )}
                                  <button
                                    title="Remove"
                                    onClick={() => removeMedia(it, m.mediaId)}
                                    className="absolute -top-1.5 -right-1.5 bg-white border border-gray-300 rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                                  >
                                    <Trash2 className="w-3 h-3 text-red-600" />
                                  </button>
                                </div>
                              ))}
                              <label className="inline-flex items-center gap-1.5 text-xs text-blue-700 border border-blue-300 rounded-lg px-2.5 py-1.5 cursor-pointer hover:bg-blue-50">
                                {uploadingFor === it.id ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <Camera className="w-3.5 h-3.5" />
                                )}
                                Add photo / video
                                <input
                                  type="file"
                                  accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime"
                                  className="hidden"
                                  disabled={uploadingFor === it.id}
                                  onChange={(e) => {
                                    const file = e.target.files?.[0];
                                    e.target.value = "";
                                    if (file) uploadMedia(it, file);
                                  }}
                                />
                              </label>
                            </div>
                          </div>
                        )}
                      </li>
                    );
                  })}
                  {items.length === 0 && (
                    <li className="px-3 py-3 text-sm text-gray-500">No inspection items for this vehicle.</li>
                  )}
                </ul>

                {items.some((i) => i.source === "recall") && (
                  <div className="bg-white rounded-lg border border-amber-200">
                    <div className="px-3 pt-2 pb-1">
                      <div className="text-xs font-semibold text-amber-800 uppercase tracking-wide">Open safety recalls</div>
                      <div className="text-[11px] text-gray-500">
                        Dealer repairs at no charge — check any you want written to the RO / shared with the customer.
                      </div>
                    </div>
                    <ul className="divide-y divide-amber-100">
                      {items.filter((i) => i.source === "recall").map((it) => (
                        <li key={it.id} className="px-3 py-2">
                          <label className="flex items-start gap-3 cursor-pointer">
                            <input
                              type="checkbox"
                              className="mt-1"
                              checked={!!checked[it.id]}
                              onChange={(e) => setChecked({ ...checked, [it.id]: e.target.checked })}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="text-sm text-gray-900">{it.name}</div>
                              {it.notes && <div className="text-xs text-gray-500">{it.notes}</div>}
                            </div>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {hidden.length > 0 && (
                  <div>
                    <button
                      onClick={() => setShowHidden(!showHidden)}
                      className="inline-flex items-center gap-1.5 text-xs text-gray-600 hover:text-gray-900"
                    >
                      <EyeOff className="w-3.5 h-3.5" /> {hidden.length} shop item{hidden.length !== 1 ? "s" : ""} hidden as
                      duplicates {showHidden ? "▴" : "▾"}
                    </button>
                    {showHidden && (
                      <ul className="mt-1 space-y-0.5">
                        {hidden.map((h) => (
                          <li key={h.item.id} className="text-xs text-gray-500 pl-5">
                            {h.item.name} — {h.reason}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {isProtractor ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm w-40"
                      placeholder="RO # (optional)"
                      value={roNumber}
                      onChange={(e) => setRoNumber(e.target.value)}
                    />
                    <button
                      onClick={push}
                      disabled={pushing}
                      className="inline-flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg px-4 py-1.5"
                    >
                      {pushing && <Loader2 className="w-4 h-4 animate-spin" />} Write inspection to open RO
                    </button>
                    <span className="text-xs text-gray-500">
                      Yellow/red ratings are tagged on each line ([Yellow] / [Red]); notes &amp; recommendations go in the package note.
                    </span>
                  </div>
                ) : (
                  <p className="text-xs text-gray-500">
                    To write this inspection to a Tekmetric RO, open the RO in Tekmetric and use the MOS side panel.
                    Findings you record here are saved and will ride along with the side-panel push.
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
