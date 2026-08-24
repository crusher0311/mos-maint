"use client";

// Task #991 — Auto DVI phone mode. A phone-optimized single-screen
// inspection: big mic button (speak the whole inspection in any language —
// AI builds/updates items, ratings and notes from the audio), camera batch
// capture with AI photo assignment, and thumb-sized rating chips.
// Uses the same APIs as the desktop panel: generate, results (autosave),
// media, voice, photo-assign.

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Mic, Square, Camera, ChevronLeft, Check, RefreshCw } from "lucide-react";

type Rating = "green" | "yellow" | "red";

type Item = {
  id: string;
  name: string;
  lineTitle: string;
  source: string;
  serviceKey: string | null;
  bucket?: string | null;
  group?: string | null;
  defaultRating?: Rating | null;
};

type MediaRef = { mediaId: string; kind: "photo" | "video"; contentType: string; filename: string | null };
type Finding = { rating: Rating | null; notes: string; recommendation: string; media: MediaRef[] };

const RATINGS: { r: Rating; label: string; on: string; off: string }[] = [
  { r: "green", label: "Good", on: "bg-green-600 text-white", off: "bg-white text-green-700 border-green-300" },
  { r: "yellow", label: "Monitor", on: "bg-yellow-500 text-white", off: "bg-white text-yellow-700 border-yellow-300" },
  { r: "red", label: "Attention", on: "bg-red-600 text-white", off: "bg-white text-red-700 border-red-300" },
];

export default function MobileInspectClient({ vin }: { vin: string }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [vehicle, setVehicle] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [findings, setFindings] = useState<Record<string, Finding>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [assignBusy, setAssignBusy] = useState(false);
  const [uploadingFor, setUploadingFor] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Map<string, string>>(new Map());
  const findingsRef = useRef(findings);
  findingsRef.current = findings;
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const empty = (): Finding => ({ rating: null, notes: "", recommendation: "", media: [] });
  const getF = (id: string) => findings[id] || empty();

  const queueSave = useCallback(
    (itemId: string, name: string) => {
      pending.current.set(itemId, name);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        const dirty = Array.from(pending.current.entries());
        pending.current.clear();
        if (!dirty.length) return;
        try {
          await fetch("/api/auto-dvi/results", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              vin,
              items: dirty.map(([itemId, name]) => {
                const f = findingsRef.current[itemId] || empty();
                return { itemId, name, rating: f.rating, notes: f.notes || null, recommendation: f.recommendation || null };
              }),
            }),
          });
        } catch {}
      }, 800);
    },
    [vin],
  );

  function patch(id: string, name: string, p: Partial<Finding>) {
    setFindings((prev) => ({ ...prev, [id]: { ...(prev[id] || empty()), ...p } }));
    queueSave(id, name);
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [genRes, savedRes] = await Promise.all([
        fetch("/api/auto-dvi/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ vin }),
        }),
        fetch(`/api/auto-dvi/results?vin=${encodeURIComponent(vin)}`),
      ]);
      const gen = await genRes.json();
      if (!genRes.ok) throw new Error(gen?.error || "Could not build the inspection");
      const list: Item[] = (gen.items || []).filter((i: Item) => i.source !== "recall");
      setItems(list);
      const v = gen.vehicle;
      setVehicle(v ? [v.year, v.make, v.model].filter(Boolean).join(" ") : null);
      const saved: Record<string, Finding> = {};
      try {
        const sr = await savedRes.json();
        for (const it of sr?.results?.items || []) {
          saved[it.itemId] = {
            rating: it.rating || null,
            notes: it.notes || "",
            recommendation: it.recommendation || "",
            media: Array.isArray(it.media) ? it.media : [],
          };
          // Saved ad-hoc voice items from an earlier session reappear.
          if (!list.some((i) => i.id === it.itemId) && String(it.itemId).startsWith("voice:") && it.name) {
            list.push({ id: it.itemId, name: it.name, lineTitle: `Inspected: ${it.name}`, source: "shop", serviceKey: null, group: "Dictated" });
          }
        }
      } catch {}
      setItems([...list]);
      setFindings((prev) => {
        const next = { ...saved, ...prev };
        for (const it of list) {
          if (it.defaultRating && !next[it.id]?.rating) next[it.id] = { ...(next[it.id] || empty()), rating: it.defaultRating };
        }
        return next;
      });
    } catch (err: any) {
      setError(err.message || "Could not build the inspection");
    } finally {
      setLoading(false);
    }
  }, [vin]);

  useEffect(() => {
    load();
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [load]);

  function checklistPayload() {
    return itemsRef.current.map((i) => ({ itemId: i.id, name: i.name, serviceKey: i.serviceKey }));
  }

  function applyFindings(fs: any[], language: string | null) {
    let n = 0;
    const added: Item[] = [];
    for (const f of fs) {
      if (!f?.itemId) continue;
      n++;
      if (!itemsRef.current.some((i) => i.id === f.itemId) && !added.some((i) => i.id === f.itemId)) {
        added.push({ id: f.itemId, name: f.name, lineTitle: f.lineTitle || `Inspected: ${f.name}`, source: "shop", serviceKey: null, group: "Dictated" });
      }
      setFindings((prev) => {
        const cur = prev[f.itemId] || empty();
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
    }
    if (added.length) setItems((prev) => [...prev, ...added]);
    setInfo(
      `Applied ${n} finding${n !== 1 ? "s" : ""}${added.length ? ` (${added.length} new)` : ""}${
        language && !/^en/i.test(language) ? ` — translated from ${language}` : ""
      }`,
    );
  }

  async function startRec() {
    setError(null);
    setInfo(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream, MediaRecorder.isTypeSupported("audio/webm") ? { mimeType: "audio/webm" } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        chunksRef.current = [];
        if (blob.size < 1000) return;
        setVoiceBusy(true);
        try {
          const form = new FormData();
          form.append("vin", vin);
          form.append("audio", new File([blob], "dictation.webm", { type: blob.type }));
          form.append("items", JSON.stringify(checklistPayload()));
          const res = await fetch("/api/auto-dvi/voice", { method: "POST", body: form });
          const data = await res.json();
          if (!res.ok || !data.ok) {
            throw new Error(data?.transcript ? `${data.error} — heard: “${String(data.transcript).slice(0, 160)}”` : data?.error || "Voice processing failed");
          }
          applyFindings(data.findings || [], data.language ?? null);
        } catch (err: any) {
          setError(err.message || "Voice processing failed");
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

  function stopRec() {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
  }

  async function uploadTo(item: Item, file: File) {
    setUploadingFor(item.id);
    try {
      const form = new FormData();
      form.append("vin", vin);
      form.append("itemId", item.id);
      form.append("itemName", item.name);
      form.append("file", file);
      const res = await fetch("/api/auto-dvi/media", { method: "POST", body: form });
      const data = await res.json();
      if (res.ok) {
        setFindings((prev) => {
          const f = prev[item.id] || empty();
          return { ...prev, [item.id]: { ...f, media: [...f.media, data.media] } };
        });
      }
    } finally {
      setUploadingFor(null);
    }
  }

  async function autoAssign(files: File[]) {
    if (!files.length) return;
    setAssignBusy(true);
    setError(null);
    setInfo(null);
    try {
      const form = new FormData();
      form.append("items", JSON.stringify(checklistPayload()));
      for (const f of files.slice(0, 8)) form.append("photos", f);
      const res = await fetch("/api/auto-dvi/photo-assign", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data?.error || "Photo assignment failed");
      let attached = 0;
      let skipped = 0;
      for (const a of data.assignments || []) {
        const file = files[a.index];
        const item = itemsRef.current.find((i) => i.id === a.itemId);
        if (file && item) {
          await uploadTo(item, file);
          attached++;
        } else if (file) skipped++;
      }
      setInfo(`Attached ${attached} photo${attached !== 1 ? "s" : ""}${skipped ? `, ${skipped} unassigned — attach manually` : ""}`);
    } catch (err: any) {
      setError(err.message || "Photo assignment failed");
    } finally {
      setAssignBusy(false);
    }
  }

  const rated = items.filter((i) => getF(i.id).rating).length;

  return (
    <div className="min-h-screen bg-gray-50 pb-32">
      <div className="sticky top-0 z-10 bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-3">
        <a href={`/dashboard/vehicles/${encodeURIComponent(vin)}/plan`} className="p-1 -ml-1 text-gray-600">
          <ChevronLeft className="w-6 h-6" />
        </a>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-gray-900 text-sm truncate">{vehicle || "Vehicle inspection"}</div>
          <div className="text-xs text-gray-500">
            {vin} · {rated}/{items.length} rated
          </div>
        </div>
        <button onClick={load} className="p-2 text-gray-500" title="Rebuild checklist">
          <RefreshCw className={`w-5 h-5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {error && <div className="mx-4 mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">{error}</div>}
      {info && <div className="mx-4 mt-3 text-sm text-blue-800 bg-blue-50 border border-blue-200 rounded-xl px-3 py-2">{info}</div>}

      {loading ? (
        <div className="flex items-center justify-center gap-2 text-gray-500 py-20">
          <Loader2 className="w-5 h-5 animate-spin" /> Building this vehicle&apos;s inspection…
        </div>
      ) : (
        <ul className="mx-4 mt-3 space-y-2">
          {items.map((it) => {
            const f = getF(it.id);
            const isOpen = open === it.id;
            return (
              <li key={it.id} className="bg-white rounded-xl border border-gray-200 px-3 py-2.5">
                <button className="w-full text-left" onClick={() => setOpen(isOpen ? null : it.id)}>
                  <div className="flex items-center gap-2">
                    <span
                      className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                        f.rating === "red" ? "bg-red-500" : f.rating === "yellow" ? "bg-yellow-400" : f.rating === "green" ? "bg-green-500" : "bg-gray-300"
                      }`}
                    />
                    <span className="text-sm text-gray-900 flex-1 min-w-0 truncate">{it.name}</span>
                    {f.media.length > 0 && <Camera className="w-4 h-4 text-blue-500 shrink-0" />}
                    {f.notes && <Check className="w-4 h-4 text-gray-400 shrink-0" />}
                  </div>
                </button>
                <div className="flex items-center gap-1.5 mt-2">
                  {RATINGS.map(({ r, label, on, off }) => (
                    <button
                      key={r}
                      onClick={() => patch(it.id, it.name, { rating: f.rating === r ? null : r })}
                      className={`flex-1 text-xs font-semibold border rounded-lg py-2 ${f.rating === r ? on : off}`}
                    >
                      {label}
                    </button>
                  ))}
                  <label className="border border-gray-300 rounded-lg p-2 text-gray-600">
                    {uploadingFor === it.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4" />}
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (file) uploadTo(it, file);
                      }}
                    />
                  </label>
                </div>
                {isOpen && (
                  <div className="mt-2 space-y-2">
                    <textarea
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                      rows={2}
                      placeholder="Notes"
                      value={f.notes}
                      onChange={(e) => patch(it.id, it.name, { notes: e.target.value })}
                    />
                    <textarea
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                      rows={1}
                      placeholder="Recommendation"
                      value={f.recommendation}
                      onChange={(e) => patch(it.id, it.name, { recommendation: e.target.value })}
                    />
                    {f.media.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {f.media.map((m) =>
                          m.kind === "photo" ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img key={m.mediaId} src={`/api/auto-dvi/media/${m.mediaId}`} alt="" className="w-16 h-16 object-cover rounded-lg border" />
                          ) : (
                            <video key={m.mediaId} src={`/api/auto-dvi/media/${m.mediaId}`} className="w-24 h-16 rounded-lg border" controls preload="metadata" />
                          ),
                        )}
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
          {items.length === 0 && <li className="text-sm text-gray-500 text-center py-10">No inspection items for this vehicle.</li>}
        </ul>
      )}

      {/* Bottom action bar: giant mic + batch camera */}
      <div className="fixed bottom-0 inset-x-0 bg-white/95 backdrop-blur border-t border-gray-200 px-4 py-3 flex items-center justify-center gap-4">
        <label className="flex flex-col items-center text-[11px] text-gray-600">
          <span className="border border-gray-300 rounded-full p-3.5">
            {assignBusy ? <Loader2 className="w-6 h-6 animate-spin" /> : <Camera className="w-6 h-6" />}
          </span>
          Auto photos
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            className="hidden"
            disabled={assignBusy}
            onChange={(e) => {
              const files = Array.from(e.target.files || []);
              e.target.value = "";
              autoAssign(files);
            }}
          />
        </label>
        <button
          onClick={() => (recording ? stopRec() : startRec())}
          disabled={voiceBusy}
          className={`flex flex-col items-center text-[11px] ${recording ? "text-red-600" : "text-blue-700"}`}
        >
          <span
            className={`rounded-full p-5 shadow-lg ${
              recording ? "bg-red-600 text-white animate-pulse" : voiceBusy ? "bg-gray-300 text-gray-600" : "bg-blue-600 text-white"
            }`}
          >
            {voiceBusy ? <Loader2 className="w-8 h-8 animate-spin" /> : recording ? <Square className="w-8 h-8" /> : <Mic className="w-8 h-8" />}
          </span>
          {recording ? "Stop & apply" : voiceBusy ? "Processing…" : "Speak inspection"}
        </button>
      </div>
    </div>
  );
}
