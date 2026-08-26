"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarClock, Pause, Play, Save, Trash2 } from "lucide-react";

type Subscription = {
  _id: string;
  recipientEmail: string;
  cadence: "weekly" | "monthly";
  timezone: string;
  sendHour: number;
  dayOfWeek?: number;
  dayOfMonth?: number;
  paused: boolean;
  reportId?: string;
  reportVersion?: number;
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: string;
};

const idOf = (subscription: Subscription) => String(subscription._id);

export function ReportingSubscriptionManager() {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [allowed, setAllowed] = useState(true);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/reports/subscriptions", { credentials: "include" });
      if (response.status === 403) { setAllowed(false); return; }
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "Scheduled deliveries could not be loaded.");
      setSubscriptions(json.subscriptions || []);
      setAllowed(true);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Scheduled deliveries could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const refresh = () => void load();
    window.addEventListener("reporting-subscriptions-changed", refresh);
    return () => window.removeEventListener("reporting-subscriptions-changed", refresh);
  }, [load]);

  const update = async (id: string, patch: Partial<Subscription>) => {
    setMessage(null);
    const response = await fetch(`/api/reports/subscriptions/${id}`, {
      method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const json = await response.json();
    if (!response.ok) { setMessage(json.error || "Scheduled delivery could not be updated."); return; }
    setSubscriptions(current => current.map(item => idOf(item) === id ? json.subscription : item));
    setMessage("Scheduled delivery updated.");
  };

  const remove = async (id: string) => {
    if (!window.confirm("Delete this scheduled delivery?")) return;
    const response = await fetch(`/api/reports/subscriptions/${id}`, { method: "DELETE", credentials: "include" });
    if (!response.ok) { setMessage("Scheduled delivery could not be deleted."); return; }
    setSubscriptions(current => current.filter(item => idOf(item) !== id));
    setMessage("Scheduled delivery deleted.");
  };

  if (!allowed) return null;
  return <section className="panel overflow-hidden">
    <div className="border-b border-slate-100 px-5 py-4">
      <div className="flex items-center gap-2"><CalendarClock className="h-4 w-4 text-[#347bbd]" /><h2 className="text-base font-bold text-slate-900">Scheduled deliveries</h2></div>
      <p className="mt-1 text-xs text-slate-500">Manage existing saved-report and legacy summary emails. Loading this list does not run a report.</p>
    </div>
    <div className="p-5">
      {loading && <p className="text-sm text-slate-500">Loading scheduled deliveries…</p>}
      {!loading && !subscriptions.length && <p className="text-sm text-slate-500">No scheduled deliveries yet.</p>}
      <div className="space-y-3">
        {subscriptions.map(subscription => <SubscriptionRow
          key={idOf(subscription)}
          subscription={subscription}
          onSave={patch => void update(idOf(subscription), patch)}
          onPause={() => void update(idOf(subscription), { paused: !subscription.paused })}
          onDelete={() => void remove(idOf(subscription))}
        />)}
      </div>
      {message && <p role="status" className="mt-3 rounded-md bg-slate-100 px-3 py-2 text-xs text-slate-700">{message}</p>}
    </div>
  </section>;
}

function SubscriptionRow({ subscription, onSave, onPause, onDelete }: {
  subscription: Subscription;
  onSave: (patch: Partial<Subscription>) => void;
  onPause: () => void;
  onDelete: () => void;
}) {
  const [recipientEmail, setRecipientEmail] = useState(subscription.recipientEmail);
  const [cadence, setCadence] = useState(subscription.cadence);
  const [timezone, setTimezone] = useState(subscription.timezone);
  const [sendHour, setSendHour] = useState(subscription.sendHour);
  const [day, setDay] = useState(subscription.cadence === "weekly" ? subscription.dayOfWeek || 1 : subscription.dayOfMonth || 1);
  useEffect(() => {
    setRecipientEmail(subscription.recipientEmail); setCadence(subscription.cadence);
    setTimezone(subscription.timezone); setSendHour(subscription.sendHour);
    setDay(subscription.cadence === "weekly" ? subscription.dayOfWeek || 1 : subscription.dayOfMonth || 1);
  }, [subscription]);

  return <div className={`rounded-lg border p-4 ${subscription.paused ? "border-slate-200 bg-slate-50" : "border-[#c7dfef] bg-white"}`}>
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div><p className="text-sm font-bold text-slate-800">{subscription.reportId ? `Saved report · version ${subscription.reportVersion || "current"}` : "Legacy KPI summary"}</p><p className="text-xs text-slate-500">{subscription.paused ? "Paused" : subscription.nextRunAt ? `Next delivery ${new Date(subscription.nextRunAt).toLocaleString()}` : "Active"}{subscription.lastStatus ? ` · Last: ${subscription.lastStatus}` : ""}</p></div>
      <div className="flex gap-2"><button className="action secondary" onClick={onPause}>{subscription.paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}{subscription.paused ? "Resume" : "Pause"}</button><button className="icon text-rose-700" title="Delete scheduled delivery" onClick={onDelete}><Trash2 className="h-4 w-4" /></button></div>
    </div>
    <div className="grid gap-2 md:grid-cols-5">
      <label className="text-xs font-bold text-slate-600 md:col-span-2">Recipient<input type="email" className="filter mt-1 w-full" value={recipientEmail} onChange={event => setRecipientEmail(event.target.value)} /></label>
      <label className="text-xs font-bold text-slate-600">Cadence<select className="filter mt-1 w-full" value={cadence} onChange={event => { const next = event.target.value as "weekly" | "monthly"; setCadence(next); setDay(1); }}><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label>
      <label className="text-xs font-bold text-slate-600">{cadence === "weekly" ? "Day (1–7)" : "Date (1–28)"}<input type="number" className="filter mt-1 w-full" min={1} max={cadence === "weekly" ? 7 : 28} value={day} onChange={event => setDay(Number(event.target.value))} /></label>
      <label className="text-xs font-bold text-slate-600">Hour (0–23)<input type="number" className="filter mt-1 w-full" min={0} max={23} value={sendHour} onChange={event => setSendHour(Number(event.target.value))} /></label>
      <label className="text-xs font-bold text-slate-600 md:col-span-2">Timezone<input className="filter mt-1 w-full" value={timezone} onChange={event => setTimezone(event.target.value)} /></label>
      <div className="flex items-end md:col-span-3"><button className="action secondary" onClick={() => onSave({
        recipientEmail: recipientEmail.trim(), cadence, timezone: timezone.trim(), sendHour,
        ...(cadence === "weekly" ? { dayOfWeek: day, dayOfMonth: undefined } : { dayOfMonth: day, dayOfWeek: undefined }),
      })}><Save className="h-4 w-4" />Save delivery</button></div>
    </div>
  </div>;
}