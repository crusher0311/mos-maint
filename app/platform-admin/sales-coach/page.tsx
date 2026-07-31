"use client";

// Sales coaching trainer (task #987, feature/sales-coach branch).
// Practice sales pitches against real work orders: pick a daily scenario,
// record your pitch, get an AI-coached critique. Every session is retained
// as a training corpus (History tab).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Mic,
  Square,
  ArrowLeft,
  RefreshCw,
  Sparkles,
  Car,
  History,
  GraduationCap,
  Loader2,
  TrendingUp,
  AlertTriangle,
  CheckCircle2,
  MessageSquareQuote,
  Upload,
  Trash2,
} from "lucide-react";
import { AudioPlayer } from "@/components/communications/AudioPlayer";

interface ScenarioJob {
  title: string;
  status: string;
  total: number;
  laborTotal: number;
  partsTotal: number;
  laborHours: number | null;
  declined: boolean;
  declineReason: string | null;
}

interface ScenarioContext {
  vehicle: { year?: number; make?: string; model?: string } | null;
  customerFirstName: string | null;
  customerConcern: string | null;
  odometerIn: number | null;
  workOrderNumber: string | null;
  grandTotal: number;
  jobs: ScenarioJob[];
  declinedTotal: number;
  provider: string | null;
}

interface Scenario {
  id: string;
  scenarioDate: string;
  scenarioType: string;
  workOrderNumber: string | null;
  context: ScenarioContext;
}

interface Feedback {
  score: number;
  summary: string;
  whatWorked: string[];
  toImprove: string[];
  suggestedPhrasing: string;
}

interface SessionRow {
  id: string;
  scenarioId: string;
  userEmail: string;
  durationSec: number | null;
  transcript: string | null;
  feedback: Feedback | null;
  score: number | null;
  createdAt: string;
  scenarioType: string;
  workOrderNumber: string | null;
  scenarioContext: ScenarioContext;
}

const typeConfig: Record<string, { label: string; color: string }> = {
  declined_work: { label: "Declined Work", color: "bg-red-50 text-red-700" },
  large_estimate: { label: "Large Estimate", color: "bg-amber-50 text-amber-700" },
  routine: { label: "Routine RO", color: "bg-green-50 text-green-700" },
};

function money(n: number) {
  return `$${(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function vehicleLabel(ctx: ScenarioContext) {
  const v = ctx.vehicle;
  const s = v ? `${v.year ?? ""} ${v.make ?? ""} ${v.model ?? ""}`.trim() : "";
  return s || "Unknown vehicle";
}

function ScoreBadge({ score }: { score: number }) {
  const color =
    score >= 80 ? "bg-green-100 text-green-700" : score >= 60 ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-700";
  return <span className={`inline-flex px-2.5 py-1 rounded-full text-sm font-semibold ${color}`}>{score}/100</span>;
}

function ScenarioCard({ ctx }: { ctx: ScenarioContext }) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 space-y-4">
      <div className="flex items-center gap-3">
        <Car className="w-6 h-6 text-blue-600" />
        <div>
          <p className="font-semibold text-gray-900">
            {vehicleLabel(ctx)}
            {ctx.odometerIn ? <span className="text-gray-500 font-normal"> · {ctx.odometerIn.toLocaleString()} mi</span> : null}
          </p>
          <p className="text-sm text-gray-500">
            {ctx.customerFirstName ? `Customer: ${ctx.customerFirstName}` : "Customer on the phone"}
            {ctx.workOrderNumber ? ` · RO #${ctx.workOrderNumber}` : ""}
          </p>
        </div>
      </div>
      {ctx.customerConcern && (
        <div className="bg-blue-50 border border-blue-100 rounded-lg p-3 text-sm text-blue-900">
          <span className="font-medium">Customer concern:</span> {ctx.customerConcern}
        </div>
      )}
      <div>
        <p className="text-sm font-medium text-gray-700 mb-2">Recommended work</p>
        <div className="divide-y divide-gray-100 border border-gray-100 rounded-lg overflow-hidden">
          {ctx.jobs.map((j, i) => (
            <div key={i} className={`flex items-center justify-between px-3 py-2 text-sm ${j.declined ? "bg-red-50/50" : ""}`}>
              <div className="min-w-0 pr-3">
                <p className="text-gray-900 truncate">{j.title}</p>
                <p className="text-xs text-gray-400">
                  Labor {money(j.laborTotal)}
                  {j.laborHours ? ` (${j.laborHours}h)` : ""} · Parts {money(j.partsTotal)}
                  {j.declined && (
                    <span className="ml-2 text-red-600 font-medium">
                      DECLINED{j.declineReason ? `: ${j.declineReason}` : ""}
                    </span>
                  )}
                </p>
              </div>
              <span className="font-medium text-gray-900 flex-shrink-0">{money(j.total)}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-gray-500">
          {ctx.declinedTotal > 0 ? `Declined work on the table: ${money(ctx.declinedTotal)}` : "No declined work"}
        </span>
        <span className="font-semibold text-gray-900">Estimate total: {money(ctx.grandTotal)}</span>
      </div>
    </div>
  );
}

function FeedbackCard({ feedback, transcript }: { feedback: Feedback; transcript: string }) {
  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-gray-900 flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-purple-600" /> Coach Feedback
          </h3>
          <ScoreBadge score={feedback.score} />
        </div>
        <p className="text-sm text-gray-700 mb-4">{feedback.summary}</p>
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <p className="text-sm font-medium text-green-700 flex items-center gap-1 mb-2">
              <CheckCircle2 className="w-4 h-4" /> What worked
            </p>
            <ul className="space-y-1.5">
              {feedback.whatWorked.map((s, i) => (
                <li key={i} className="text-sm text-gray-700 bg-green-50 rounded-lg px-3 py-2">{s}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-sm font-medium text-amber-700 flex items-center gap-1 mb-2">
              <AlertTriangle className="w-4 h-4" /> To improve
            </p>
            <ul className="space-y-1.5">
              {feedback.toImprove.map((s, i) => (
                <li key={i} className="text-sm text-gray-700 bg-amber-50 rounded-lg px-3 py-2">{s}</li>
              ))}
            </ul>
          </div>
        </div>
        {feedback.suggestedPhrasing && (
          <div className="mt-4 bg-purple-50 border border-purple-100 rounded-lg p-3">
            <p className="text-sm font-medium text-purple-700 flex items-center gap-1 mb-1">
              <MessageSquareQuote className="w-4 h-4" /> Try saying it like this
            </p>
            <p className="text-sm text-purple-900 italic">“{feedback.suggestedPhrasing}”</p>
          </div>
        )}
      </div>
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h3 className="text-sm font-medium text-gray-700 mb-2">Transcript</h3>
        <p className="text-sm text-gray-600 whitespace-pre-wrap">{transcript}</p>
      </div>
    </div>
  );
}

function Recorder({ scenarioId, onDone }: { scenarioId: string; onDone: (s: any) => void }) {
  const [recording, setRecording] = useState(false);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const durationRef = useRef(0);

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    recorderRef.current?.stream.getTracks().forEach((t) => t.stop());
  }, [blobUrl]);

  const start = async () => {
    setError(null);
    setBlob(null);
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      setBlobUrl(null);
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : undefined;
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data);
      rec.onstop = () => {
        const b = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        setBlob(b);
        setBlobUrl(URL.createObjectURL(b));
        stream.getTracks().forEach((t) => t.stop());
      };
      rec.start();
      recorderRef.current = rec;
      setRecording(true);
      setElapsed(0);
      durationRef.current = 0;
      timerRef.current = setInterval(() => {
        durationRef.current += 1;
        setElapsed(durationRef.current);
      }, 1000);
    } catch (e: any) {
      setError(e?.name === "NotAllowedError" ? "Microphone access was denied. Allow it in your browser and try again." : e?.message || "Could not start recording");
    }
  };

  const stop = () => {
    recorderRef.current?.stop();
    setRecording(false);
    if (timerRef.current) clearInterval(timerRef.current);
  };

  const submit = async () => {
    if (!blob) return;
    setSubmitting(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("scenarioId", scenarioId);
      form.append("durationSec", String(durationRef.current));
      form.append("audio", new File([blob], "pitch.webm", { type: blob.type || "audio/webm" }));
      const res = await fetch("/api/platform-admin/sales-coach/sessions", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      onDone(data.session);
    } catch (e: any) {
      setError(e?.message || "Upload failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
      <h3 className="font-semibold text-gray-900 mb-1">Your pitch</h3>
      <p className="text-sm text-gray-500 mb-4">
        Imagine the customer just heard the estimate. Record how you would present the work — build value, use the real prices, and try to save the declined items.
      </p>
      {error && <div className="mb-4 bg-red-50 border border-red-100 text-red-700 text-sm rounded-lg p-3">{error}</div>}
      <div className="flex items-center gap-4 flex-wrap">
        {!recording ? (
          <button
            onClick={start}
            disabled={submitting}
            className="flex items-center gap-2 px-5 py-2.5 bg-red-600 text-white rounded-full hover:bg-red-700 transition-colors disabled:opacity-50"
          >
            <Mic className="w-4 h-4" /> {blob ? "Re-record" : "Start recording"}
          </button>
        ) : (
          <button
            onClick={stop}
            className="flex items-center gap-2 px-5 py-2.5 bg-gray-900 text-white rounded-full hover:bg-gray-700 transition-colors"
          >
            <Square className="w-4 h-4" /> Stop
          </button>
        )}
        {recording && (
          <span className="flex items-center gap-2 text-red-600 text-sm font-medium">
            <span className="w-2.5 h-2.5 rounded-full bg-red-600 animate-pulse" />
            Recording… {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
          </span>
        )}
      </div>
      {blob && blobUrl && !recording && (
        <div className="mt-4 space-y-3">
          <div className="max-w-md">
            <AudioPlayer src={blobUrl} duration={durationRef.current} />
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={submit}
              disabled={submitting}
              className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              {submitting ? "Transcribing & coaching…" : "Get coaching feedback"}
            </button>
            <button
              onClick={() => {
                setBlob(null);
                if (blobUrl) URL.revokeObjectURL(blobUrl);
                setBlobUrl(null);
              }}
              disabled={submitting}
              className="flex items-center gap-1.5 px-3 py-2 text-sm text-gray-500 hover:text-gray-700"
            >
              <Trash2 className="w-4 h-4" /> Discard
            </button>
          </div>
          {submitting && (
            <p className="text-xs text-gray-400">This usually takes 10–20 seconds — the audio is transcribed and scored against the RO&apos;s actual jobs and prices.</p>
          )}
        </div>
      )}
    </div>
  );
}

export default function SalesCoachPage() {
  const [tab, setTab] = useState<"practice" | "history">("practice");
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [scenarioDate, setScenarioDate] = useState<string>("");
  const [isToday, setIsToday] = useState(true);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [selected, setSelected] = useState<Scenario | null>(null);
  const [result, setResult] = useState<any | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadScenarios = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/platform-admin/sales-coach/scenarios");
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setScenarios(data.scenarios);
      setScenarioDate(data.date || "");
      setIsToday(!!data.isToday);
    } catch (e: any) {
      setError(e?.message || "Failed to load scenarios");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const res = await fetch("/api/platform-admin/sales-coach/sessions");
      const data = await res.json();
      if (res.ok && data.ok) setSessions(data.sessions);
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadScenarios();
  }, [loadScenarios]);

  useEffect(() => {
    if (tab === "history") loadSessions();
  }, [tab, loadSessions]);

  const generateNow = async () => {
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/platform-admin/sales-coach/scenarios", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      await loadScenarios();
    } catch (e: any) {
      setError(e?.message || "Generate failed");
    } finally {
      setGenerating(false);
    }
  };

  // ── Scenario practice view ────────────────────────────────────────────
  if (selected) {
    const cfg = typeConfig[selected.scenarioType] || { label: selected.scenarioType, color: "bg-gray-100 text-gray-600" };
    return (
      <div className="p-6 max-w-4xl mx-auto space-y-6">
        <button
          onClick={() => {
            setSelected(null);
            setResult(null);
          }}
          className="flex items-center gap-2 text-gray-600 hover:text-gray-900"
        >
          <ArrowLeft className="w-4 h-4" /> Back to scenarios
        </button>
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-bold text-gray-900">Practice: {vehicleLabel(selected.context)}</h1>
          <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${cfg.color}`}>{cfg.label}</span>
        </div>
        <ScenarioCard ctx={selected.context} />
        {result ? (
          <>
            <FeedbackCard feedback={result.feedback} transcript={result.transcript} />
            <button
              onClick={() => setResult(null)}
              className="flex items-center gap-2 px-4 py-2 border border-gray-200 rounded-lg text-sm text-gray-700 hover:bg-gray-50"
            >
              <Mic className="w-4 h-4" /> Practice this scenario again
            </button>
          </>
        ) : (
          <Recorder scenarioId={selected.id} onDone={setResult} />
        )}
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <GraduationCap className="w-7 h-7 text-blue-600" /> Sales Coach
          </h1>
          <p className="text-gray-600">Practice sales conversations against real work orders and get AI coaching.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setTab("practice")}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium ${tab === "practice" ? "bg-blue-600 text-white" : "text-gray-600 hover:bg-gray-100"}`}
          >
            Today&apos;s Scenarios
          </button>
          <button
            onClick={() => setTab("history")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium ${tab === "history" ? "bg-blue-600 text-white" : "text-gray-600 hover:bg-gray-100"}`}
          >
            <History className="w-4 h-4" /> History
          </button>
        </div>
      </div>

      {error && <div className="bg-red-50 border border-red-100 text-red-700 text-sm rounded-lg p-3">{error}</div>}

      {tab === "practice" ? (
        <>
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-500">
              {scenarioDate ? (isToday ? `Scenarios for today (${scenarioDate})` : `No scenarios yet today — showing ${scenarioDate}`) : "No scenarios yet"}
            </p>
            <button
              onClick={generateNow}
              disabled={generating}
              className="flex items-center gap-2 px-3 py-1.5 border border-gray-200 rounded-lg text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Generate now
            </button>
          </div>
          {loading ? (
            <div className="p-12 text-center text-gray-400">
              <Loader2 className="w-8 h-8 mx-auto animate-spin" />
            </div>
          ) : scenarios.length === 0 ? (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 text-center text-gray-500">
              <GraduationCap className="w-12 h-12 mx-auto mb-3 opacity-40" />
              <p className="mb-1">No practice scenarios yet.</p>
              <p className="text-sm">The daily job samples 3–5 real work orders each morning — or hit “Generate now”.</p>
            </div>
          ) : (
            <div className="grid md:grid-cols-2 gap-4">
              {scenarios.map((s) => {
                const cfg = typeConfig[s.scenarioType] || { label: s.scenarioType, color: "bg-gray-100 text-gray-600" };
                const declinedCount = s.context.jobs.filter((j) => j.declined).length;
                return (
                  <button
                    key={s.id}
                    onClick={() => setSelected(s)}
                    className="text-left bg-white rounded-xl shadow-sm border border-gray-100 p-5 hover:border-blue-300 hover:shadow transition-all"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${cfg.color}`}>{cfg.label}</span>
                      <span className="text-sm font-semibold text-gray-900">{money(s.context.grandTotal)}</span>
                    </div>
                    <p className="font-medium text-gray-900">{vehicleLabel(s.context)}</p>
                    <p className="text-sm text-gray-500 mt-1 line-clamp-2">
                      {s.context.customerConcern || `${s.context.jobs.length} recommended job${s.context.jobs.length === 1 ? "" : "s"}`}
                    </p>
                    <p className="text-xs text-gray-400 mt-2">
                      {s.context.jobs.length} jobs
                      {declinedCount > 0 ? ` · ${declinedCount} declined (${money(s.context.declinedTotal)})` : ""}
                      {s.workOrderNumber ? ` · RO #${s.workOrderNumber}` : ""}
                    </p>
                  </button>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <HistoryTab
          sessions={sessions}
          loading={sessionsLoading}
          expanded={expandedSession}
          onToggle={(id) => setExpandedSession(expandedSession === id ? null : id)}
        />
      )}
    </div>
  );
}

function HistoryTab({
  sessions,
  loading,
  expanded,
  onToggle,
}: {
  sessions: SessionRow[];
  loading: boolean;
  expanded: string | null;
  onToggle: (id: string) => void;
}) {
  if (loading) {
    return (
      <div className="p-12 text-center text-gray-400">
        <Loader2 className="w-8 h-8 mx-auto animate-spin" />
      </div>
    );
  }
  if (sessions.length === 0) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 text-center text-gray-500">
        <History className="w-12 h-12 mx-auto mb-3 opacity-40" />
        <p>No practice sessions yet. Record your first pitch from a scenario.</p>
      </div>
    );
  }
  const scored = sessions.filter((s) => s.score != null);
  const avg = scored.length ? Math.round(scored.reduce((a, s) => a + (s.score || 0), 0) / scored.length) : null;
  const last5 = scored.slice(0, 5);
  const last5Avg = last5.length ? Math.round(last5.reduce((a, s) => a + (s.score || 0), 0) / last5.length) : null;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 text-center">
          <p className="text-xs text-gray-500 mb-1">Sessions</p>
          <p className="text-xl font-semibold text-gray-900">{sessions.length}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 text-center">
          <p className="text-xs text-gray-500 mb-1">Average score</p>
          <p className="text-xl font-semibold text-gray-900">{avg ?? "—"}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 text-center">
          <p className="text-xs text-gray-500 mb-1 flex items-center justify-center gap-1">
            <TrendingUp className="w-3.5 h-3.5" /> Last 5 avg
          </p>
          <p className="text-xl font-semibold text-gray-900">{last5Avg ?? "—"}</p>
        </div>
      </div>
      <div className="space-y-3">
        {sessions.map((s) => (
          <div key={s.id} className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <button onClick={() => onToggle(s.id)} className="w-full text-left px-5 py-4 hover:bg-gray-50 transition-colors">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <p className="font-medium text-gray-900">
                    {vehicleLabel(s.scenarioContext)}
                    <span className="ml-2 text-xs text-gray-400">
                      {(typeConfig[s.scenarioType]?.label) || s.scenarioType}
                      {s.workOrderNumber ? ` · RO #${s.workOrderNumber}` : ""}
                    </span>
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {new Date(s.createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
                    {" · "}{s.userEmail}
                    {s.durationSec ? ` · ${Math.floor(s.durationSec / 60)}:${String(s.durationSec % 60).padStart(2, "0")}` : ""}
                  </p>
                </div>
                {s.score != null && <ScoreBadge score={s.score} />}
              </div>
            </button>
            {expanded === s.id && (
              <div className="px-5 pb-5 space-y-4 border-t border-gray-100 pt-4">
                <div className="max-w-md">
                  <AudioPlayer src={`/api/platform-admin/sales-coach/sessions/${s.id}/audio`} duration={s.durationSec || undefined} />
                </div>
                {s.feedback && <FeedbackCard feedback={s.feedback} transcript={s.transcript || ""} />}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
