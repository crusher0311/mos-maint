"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Building2, LockKeyhole } from "lucide-react";

type Policy = { enabled: boolean; stage: "performed" | "deferred" | "reconcile"; shopIds: number[]; revision: number };
type SettingsResponse = { policy: Policy; locations: { shopId: number; name: string }[]; canManage: boolean };
const STAGES = [
  { value: "performed", label: "Performed work", description: "Show completed service evidence." },
  { value: "deferred", label: "Performed + deferred", description: "Also show declined or deferred source jobs." },
  { value: "reconcile", label: "Completion evidence", description: "Also show completion elsewhere and remaining components. No jobs are changed." },
] as const;

export default function VehicleHistorySharingSettings() {
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<Policy | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const generation = useRef(0);
  const load = useCallback(async (conflict = false) => {
    const sequence = ++generation.current;
    setLoading(true);
    setSettings(null);
    setDraft(null);
    setError(null);
    setNotice(conflict ? "Sharing changed in another session. The latest policy is loaded; review it before saving again." : null);
    try {
      const response = await fetch("/api/settings/vehicle-history", { credentials: "include", cache: "no-store" });
      if (!response.ok) throw new Error("Settings unavailable");
      const data: SettingsResponse = await response.json();
      if (!data.policy || !Array.isArray(data.locations) || !Array.isArray(data.policy.shopIds) ||
          typeof data.canManage !== "boolean" || !Number.isInteger(data.policy.revision) ||
          !STAGES.some(stage => stage.value === data.policy.stage)) throw new Error("Invalid sharing settings");
      if (sequence !== generation.current) return;
      setSettings(data);
      // Only the server's admin-authorized location list may enter the draft.
      setDraft({ ...data.policy, enabled: data.policy.enabled === true, shopIds: data.policy.shopIds.filter(id => data.locations.some(location => location.shopId === id)) });
    } catch {
      if (sequence === generation.current) setError("Sharing settings are unavailable. No policy has been changed.");
    } finally {
      if (sequence === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);

  async function save() {
    if (!settings?.canManage || !draft || saving) return;
    if (draft.enabled && !draft.shopIds.length) { setError("Select at least one authorized location before enabling sharing."); return; }
    if (draft.shopIds.some(id => !settings.locations.some(location => location.shopId === id))) { setError("One or more locations are not authorized."); return; }
    setSaving(true); setError(null); setNotice(null);
    const sequence = generation.current;
    try {
      const response = await fetch("/api/settings/vehicle-history", {
        method: "PUT", credentials: "include", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft),
      });
      if (sequence !== generation.current) return;
      if (response.status === 409) { await load(true); return; }
      if (!response.ok) throw new Error("Unable to save sharing policy");
      // Refetch authorized scope as well as revision after any policy mutation.
      await load();
      if (generation.current === sequence + 1) setNotice("Sharing policy saved. Repair order actions and job search settings are unchanged.");
    } catch {
      if (sequence === generation.current) setError("Could not confirm the save. Reload the policy before trying again.");
    } finally { setSaving(false); }
  }

  const locked = !settings?.canManage || saving;
  const changed = settings && draft && JSON.stringify(settings.policy) !== JSON.stringify(draft);
  return <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm" aria-label="Vehicle history sharing">
    <h2 className="flex items-center gap-3 text-lg font-semibold text-gray-900"><Building2 className="h-5 w-5 text-gray-500" />Vehicle history sharing</h2>
    <p className="mt-3 text-sm text-gray-500">Share read-only vehicle evidence across explicitly selected, admin-authorized locations. Sharing is off by default and is separate from Job History Locations for job search.</p>
    <p className="mt-3 flex items-start gap-2 rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-800"><LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" />No changes to repair order actions. Cross-location evidence cannot add, edit, or resolve another shop’s jobs.</p>
    {loading ? <div role="status" className="mt-5 space-y-3"><p className="text-sm text-gray-500">Loading authorized sharing policy…</p><div className="h-12 rounded-lg bg-gray-100" /><div className="h-20 rounded-lg bg-gray-100" /></div> : draft && settings ? <div className="mt-5 space-y-5">
      {!settings.canManage && <p className="rounded-lg bg-gray-50 p-3 text-sm text-gray-600">Only an authorized owner or admin can manage sharing. You can view the policy below.</p>}
      <label className="flex items-start gap-3 rounded-lg border border-gray-200 p-4"><input type="checkbox" className="mt-1 h-4 w-4 accent-blue-600" checked={draft.enabled} disabled={locked} onChange={event => { setDraft({ ...draft, enabled: event.target.checked }); setNotice(null); }} /><span><span className="block font-medium text-gray-900">Enable vehicle history sharing</span><span className="mt-1 block text-sm text-gray-500">{draft.enabled ? "Sharing applies only after saving this policy." : "Off. No cross-location vehicle history is shared."}</span></span></label>
      <fieldset disabled={locked} className="space-y-2"><legend className="mb-2 text-sm font-medium text-gray-700">Evidence stage</legend>{STAGES.map(stage => <label key={stage.value} className={`flex items-start gap-3 rounded-lg border p-3 ${draft.stage === stage.value ? "border-blue-200 bg-blue-50" : "border-gray-200"}`}><input type="radio" name="vehicle-history-stage" className="mt-1 accent-blue-600" checked={draft.stage === stage.value} onChange={() => setDraft({ ...draft, stage: stage.value })} /><span><span className="block text-sm font-medium text-gray-900">{stage.label}</span><span className="block text-xs text-gray-500">{stage.description}</span></span></label>)}</fieldset>
      <fieldset disabled={locked}><legend className="mb-2 text-sm font-medium text-gray-700">Authorized locations · {draft.shopIds.length} selected</legend><p className="mb-3 text-xs text-gray-500">Nothing is selected automatically. Only locations returned as admin-authorized can be saved.</p><div className="grid grid-cols-1 gap-3 md:grid-cols-2">{settings.locations.map(location => <label key={location.shopId} className={`flex items-start gap-3 rounded-lg border p-3 ${draft.shopIds.includes(location.shopId) ? "border-blue-200 bg-blue-50" : "border-gray-200"}`}><input type="checkbox" className="mt-1 accent-blue-600" checked={draft.shopIds.includes(location.shopId)} onChange={event => setDraft({ ...draft, shopIds: event.target.checked ? [...draft.shopIds, location.shopId] : draft.shopIds.filter(id => id !== location.shopId) })} /><span className="text-sm text-gray-800">{location.name}</span></label>)}</div>{!settings.locations.length && <p className="rounded-lg bg-gray-50 p-4 text-sm text-gray-600">No admin-authorized locations are available. Sharing cannot be enabled.</p>}</fieldset>
      <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-gray-500">Policy revision {draft.revision} · {settings.policy.enabled ? "Currently enabled" : "Currently off"}</p>{settings.canManage && <button type="button" disabled={locked || !changed || (draft.enabled && !draft.shopIds.length)} onClick={() => void save()} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">{saving ? "Saving policy…" : "Save sharing policy"}</button>}</div>
    </div> : null}
    <div aria-live="polite">{notice && <p className="mt-4 rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-800">{notice}</p>}{error && <div role="alert" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"><p>{error}</p><button type="button" disabled={loading || saving} onClick={() => void load()} className="mt-2 font-medium underline">Reload policy</button></div>}</div>
  </section>;
}
