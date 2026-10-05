"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Network, RefreshCw, RotateCcw, Save, X } from "lucide-react";
import {
  defaultAutoflowWorkflowMapping,
  normalizeAutoflowWorkflowStatus,
  type AutoflowWorkflowBucket,
  type AutoflowWorkflowMapping,
} from "@/lib/autoflow-workflow";

interface AutoflowShop {
  shopId: string | number;
  name: string;
  autoflowDomain: string | null;
}

interface ObservedStatus {
  label: string;
  count: number;
  lastSeenAt: string | null;
}

interface Bounds {
  lookbackDays: number;
  maxEvents: number;
  maxLabels: number;
}

interface RevisionConflict {
  latestLoaded: boolean;
  reviewed: boolean;
}

const emptyMapping = (): AutoflowWorkflowMapping => ({ active: [], closed: [], excluded: [] });
const emptyNewLabels = (): Record<AutoflowWorkflowBucket, string> => ({
  active: "", closed: "", excluded: "",
});
const buckets: AutoflowWorkflowBucket[] = ["active", "closed", "excluded"];

function cloneMapping(mapping: AutoflowWorkflowMapping | null): AutoflowWorkflowMapping {
  return mapping
    ? { active: [...mapping.active], closed: [...mapping.closed], excluded: [...mapping.excluded] }
    : emptyMapping();
}

function labelsFor(mapping: AutoflowWorkflowMapping, bucket: AutoflowWorkflowBucket) {
  return mapping[bucket];
}

function assignedBucket(mapping: AutoflowWorkflowMapping, label: string): AutoflowWorkflowBucket | "unknown" {
  const key = normalizeAutoflowWorkflowStatus(label);
  return buckets.find((bucket) => labelsFor(mapping, bucket).some((item) => normalizeAutoflowWorkflowStatus(item) === key)) ?? "unknown";
}

const formatDate = (value: string | null) => (value ? new Date(value).toLocaleString() : "—");
function parseResponseRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("The server returned an invalid workflow revision. Reload this shop before making changes.");
  }
  return value;
}

function MappingSummary({ title, mapping }: { title: string; mapping: AutoflowWorkflowMapping }) {
  return (
    <div className="rounded-lg border border-amber-200 bg-white p-3">
      <h4 className="text-sm font-semibold text-gray-900">{title}</h4>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        {buckets.map((bucket) => (
          <div key={bucket}>
            <div className="text-xs font-medium capitalize text-gray-600">{bucket}</div>
            <div className="mt-1 text-xs text-gray-800">
              {mapping[bucket].length ? mapping[bucket].join(", ") : <span className="italic text-gray-400">None</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AutoflowWorkflowMapping() {
  const [shops, setShops] = useState<AutoflowShop[]>([]);
  const [shopId, setShopId] = useState("");
  const [mapping, setMapping] = useState<AutoflowWorkflowMapping>(emptyMapping);
  const [savedMapping, setSavedMapping] = useState<AutoflowWorkflowMapping | null>(null);
  const [observed, setObserved] = useState<ObservedStatus[]>([]);
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const [loadedShopId, setLoadedShopId] = useState("");
  const [loadingShops, setLoadingShops] = useState(true);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [conflict, setConflict] = useState<RevisionConflict | null>(null);
  const [invalidStoredMapping, setInvalidStoredMapping] = useState(false);
  const [newLabel, setNewLabel] = useState<Record<AutoflowWorkflowBucket, string>>(emptyNewLabels);
  const detailRequest = useRef(0);
  const detailAbort = useRef<AbortController | null>(null);
  const currentShopId = useRef("");

  const loadShops = useCallback(async () => {
    setLoadingShops(true);
    setError(null);
    try {
      const response = await fetch("/api/platform-admin/autoflow-workflows");
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
      setShops(data.shops || []);
    } catch (caught: any) {
      setError(caught?.message || "Failed to load AutoFlow shops.");
    } finally {
      setLoadingShops(false);
    }
  }, []);

  useEffect(() => {
    loadShops();
    return () => detailAbort.current?.abort();
  }, [loadShops]);

  const loadDetails = useCallback(async (nextShopId: string) => {
    detailAbort.current?.abort();
    const request = ++detailRequest.current;
    setLoadedShopId("");
    setMapping(emptyMapping());
    setSavedMapping(null);
    setObserved([]);
    setBounds(null);
    setNewLabel(emptyNewLabels());
    setRevision(0);
    setConflict(null);
    setInvalidStoredMapping(false);
    setError(null);
    setNotice(null);
    setWarning(null);
    if (!nextShopId) {
      setLoadingDetails(false);
      return;
    }
    const controller = new AbortController();
    detailAbort.current = controller;
    setLoadingDetails(true);
    try {
      const response = await fetch(`/api/platform-admin/autoflow-workflows?shopId=${encodeURIComponent(nextShopId)}`, { signal: controller.signal });
      const data = await response.json();
      if (response.status === 409 && data?.code === "INVALID_WORKFLOW_MAPPING") {
        if (request !== detailRequest.current) return;
        setRevision(parseResponseRevision(data.revision));
        setObserved(data.observed || []);
        setBounds(data.bounds || null);
        setInvalidStoredMapping(true);
        setLoadedShopId(nextShopId);
        return;
      }
      if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
      if (request !== detailRequest.current) return;
      const received = data.mapping as AutoflowWorkflowMapping | null;
      setSavedMapping(received ? cloneMapping(received) : null);
      setMapping(received ? cloneMapping(received) : defaultAutoflowWorkflowMapping());
      setObserved(data.observed || []);
      setBounds(data.bounds || null);
      setRevision(parseResponseRevision(data.revision));
      setLoadedShopId(nextShopId);
    } catch (caught: any) {
      if (caught?.name !== "AbortError" && request === detailRequest.current) {
        setLoadedShopId("");
        setMapping(emptyMapping());
        setSavedMapping(null);
        setObserved([]);
        setBounds(null);
        setError(caught?.message || "Failed to load workflow settings.");
      }
    } finally {
      if (request === detailRequest.current) setLoadingDetails(false);
    }
  }, []);

  function changeShop(nextShopId: string) {
    if (
      nextShopId !== shopId &&
      conflict &&
      !confirm("Switch shops and discard the preserved workflow draft that is under conflict review?")
    ) {
      return;
    }
    currentShopId.current = nextShopId;
    setShopId(nextShopId);
    void loadDetails(nextShopId);
  }

  function assign(label: string, nextBucket: AutoflowWorkflowBucket | "unknown") {
    setMapping((current) => {
      const key = normalizeAutoflowWorkflowStatus(label);
      const cleaned: AutoflowWorkflowMapping = {
        active: current.active.filter((item) => normalizeAutoflowWorkflowStatus(item) !== key),
        closed: current.closed.filter((item) => normalizeAutoflowWorkflowStatus(item) !== key),
        excluded: current.excluded.filter((item) => normalizeAutoflowWorkflowStatus(item) !== key),
      };
      if (nextBucket !== "unknown") cleaned[nextBucket] = [...cleaned[nextBucket], label.trim()];
      return cleaned;
    });
  }

  function addLabel(bucket: AutoflowWorkflowBucket) {
    const label = newLabel[bucket].trim().replace(/\s+/g, " ");
    if (!label) return;
    assign(label, bucket);
    setNewLabel((current) => ({ ...current, [bucket]: "" }));
  }

  async function reloadAfterConflict() {
    if (!shopId || loadedShopId !== shopId || loadingDetails || saving || resetting) return;
    const reloadingShopId = shopId;
    detailAbort.current?.abort();
    const request = ++detailRequest.current;
    const controller = new AbortController();
    detailAbort.current = controller;
    setLoadingDetails(true);
    setError(null);
    setNotice(null);
    setWarning(null);
    try {
      const response = await fetch(`/api/platform-admin/autoflow-workflows?shopId=${encodeURIComponent(reloadingShopId)}`, { signal: controller.signal });
      const data = await response.json();
      if (request !== detailRequest.current || reloadingShopId !== currentShopId.current) return;
      if (response.status === 409 && data?.code === "INVALID_WORKFLOW_MAPPING") {
        setSavedMapping(null);
        setRevision(parseResponseRevision(data.revision));
        setObserved(data.observed || []);
        setBounds(data.bounds || null);
        setInvalidStoredMapping(true);
        setConflict({ latestLoaded: true, reviewed: false });
        setError("The latest saved workflow mapping is invalid. Your draft is still shown; reset the invalid saved mapping before saving a replacement.");
        return;
      }
      if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
      const received = data.mapping as AutoflowWorkflowMapping | null;
      setSavedMapping(received ? cloneMapping(received) : null);
      setRevision(parseResponseRevision(data.revision));
      setObserved(data.observed || []);
      setBounds(data.bounds || null);
      setInvalidStoredMapping(false);
      setConflict({ latestLoaded: true, reviewed: false });
    } catch (caught: any) {
      if (caught?.name !== "AbortError" && request === detailRequest.current && reloadingShopId === currentShopId.current) {
        setError(caught?.message || "Failed to reload the latest workflow mapping. Your draft has been preserved.");
      }
    } finally {
      if (request === detailRequest.current) setLoadingDetails(false);
    }
  }

  async function save() {
    if (!shopId || loadedShopId !== shopId || saving || resetting) return;
    if (invalidStoredMapping || (conflict && !conflict.reviewed)) return;
    const savingShopId = shopId;
    const request = detailRequest.current;
    const expectedRevision = revision;
    const draft = cloneMapping(mapping);
    setSaving(true);
    setError(null);
    setNotice(null);
    setWarning(null);
    try {
      const response = await fetch("/api/platform-admin/autoflow-workflows", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopId: savingShopId, mapping: draft, expectedRevision }),
      });
      const data = await response.json();
      if (response.status === 409 && data?.code === "WORKFLOW_REVISION_CONFLICT") {
        if (request === detailRequest.current && savingShopId === currentShopId.current) {
          setMapping(draft);
          setConflict({ latestLoaded: false, reviewed: false });
          setError(null);
        }
        return;
      }
      if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
      if (request !== detailRequest.current || savingShopId !== currentShopId.current) return;
      const nextRevision = parseResponseRevision(data.revision);
      setMapping(cloneMapping(data.mapping));
      setSavedMapping(cloneMapping(data.mapping));
      setRevision(nextRevision);
      setConflict(null);
      setInvalidStoredMapping(false);
      setNotice("Workflow mapping saved. Existing events will be reevaluated; refresh the dashboard to see the updated classifications.");
      setWarning(typeof data.warning === "string" && data.warning.trim() ? data.warning : null);
    } catch (caught: any) {
      if (request === detailRequest.current && savingShopId === currentShopId.current) {
        setError(caught?.message || "Failed to save workflow mapping.");
      }
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    if (!shopId || loadedShopId !== shopId || saving || resetting) return;
    if (conflict && !conflict.reviewed) return;
    const resettingShopId = shopId;
    const request = detailRequest.current;
    const expectedRevision = revision;
    const draftBeforeReset = cloneMapping(mapping);
    const preserveConflictDraft = invalidStoredMapping && Boolean(conflict);
    if (!confirm("Reset this shop's saved workflow mapping? This removes only its explicit rules.")) return;
    setResetting(true);
    setError(null);
    setNotice(null);
    setWarning(null);
    try {
      const response = await fetch("/api/platform-admin/autoflow-workflows", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopId: resettingShopId, expectedRevision }),
      });
      const data = await response.json();
      if (response.status === 409 && data?.code === "WORKFLOW_REVISION_CONFLICT") {
        if (request === detailRequest.current && resettingShopId === currentShopId.current) {
          setConflict({ latestLoaded: false, reviewed: false });
          setError(null);
        }
        return;
      }
      if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
      if (request !== detailRequest.current || resettingShopId !== currentShopId.current) return;
      const nextRevision = parseResponseRevision(data.revision);
      const received = data.mapping as AutoflowWorkflowMapping | null;
      setSavedMapping(received ? cloneMapping(received) : null);
      setMapping(preserveConflictDraft ? draftBeforeReset : received ? cloneMapping(received) : defaultAutoflowWorkflowMapping());
      setRevision(nextRevision);
      setConflict(preserveConflictDraft ? { latestLoaded: true, reviewed: false } : null);
      setInvalidStoredMapping(false);
      setNotice(preserveConflictDraft
        ? "The invalid saved mapping was reset. Your draft is preserved; compare it with the platform default and review again before saving."
        : "Saved workflow mapping reset. The platform default applies until this shop is explicitly configured again.");
      setWarning(typeof data.warning === "string" && data.warning.trim() ? data.warning : null);
    } catch (caught: any) {
      if (request === detailRequest.current && resettingShopId === currentShopId.current) {
        setError(caught?.message || "Failed to reset workflow mapping.");
      }
    } finally {
      setResetting(false);
    }
  }

  const observedKeys = new Set(observed.map((item) => normalizeAutoflowWorkflowStatus(item.label)));
  const selectedShop = shops.find((shop) => String(shop.shopId) === shopId);
  const detailReady = Boolean(shopId) && loadedShopId === shopId;
  const isMutating = saving || resetting;
  const reviewRequired = Boolean(conflict && !conflict.reviewed);
  const editingDisabled = isMutating || invalidStoredMapping || reviewRequired;

  return (
    <section className="bg-white rounded-xl border border-gray-200 shadow-sm mb-8" aria-labelledby="workflow-mapping-heading">
      <div className="px-5 py-4 border-b border-gray-100 flex gap-3">
        <Network className="w-5 h-5 text-blue-600 mt-0.5" />
        <div>
          <h2 id="workflow-mapping-heading" className="font-semibold text-gray-900">Per-shop workflow mapping</h2>
          <p className="text-sm text-gray-500 mt-1">
            Workflow rules apply to AutoFlow-connected shops, including shops with no numeric alias.
          </p>
        </div>
      </div>
      <div className="px-5 py-4">
        {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>}
        {notice && <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 flex gap-2"><CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />{notice}</div>}
        {warning && <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"><strong>The mapping change was committed, but a follow-up action failed:</strong> {warning}</div>}
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <label className="block md:w-[420px]">
            <span className="block mb-1 text-xs font-medium text-gray-700">AutoFlow-connected shop</span>
            <select value={shopId} onChange={(event) => changeShop(event.target.value)} disabled={loadingShops || isMutating} className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm bg-white disabled:opacity-60">
              <option value="">{loadingShops ? "Loading shops…" : "Select shop…"}</option>
              {shops.map((shop) => <option key={String(shop.shopId)} value={String(shop.shopId)}>{shop.name} · MOS ID {shop.shopId}{shop.autoflowDomain ? ` · ${shop.autoflowDomain}` : ""}</option>)}
            </select>
          </label>
          <button onClick={loadShops} disabled={loadingShops} className="inline-flex items-center justify-center gap-1.5 px-3 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-40"><RefreshCw className="w-4 h-4" /> Refresh shops</button>
        </div>

        {shopId && (
          <div className="mt-5">
            {loadingDetails || !detailReady ? <div className="py-8 text-center text-sm text-gray-500">{loadingDetails ? "Loading workflow settings…" : "Workflow settings could not be loaded for this shop."}</div> : (
              <>
                <div className="flex flex-col gap-2 border-y border-gray-100 py-3 text-sm md:flex-row md:items-center md:justify-between">
                  <div><span className="font-medium text-gray-900">{selectedShop?.name}</span><span className="text-gray-500"> · MOS ID {shopId}</span></div>
                  <div className="text-xs text-gray-500"><span className="mr-2">Revision {revision}</span>· {bounds ? `Observed in the last ${bounds.lookbackDays} days · up to ${bounds.maxLabels} labels / ${bounds.maxEvents.toLocaleString()} events` : "Observed statuses"}</div>
                </div>
                {invalidStoredMapping ? (
                  <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-800">
                    <p className="font-semibold">This shop’s stored mapping is invalid.</p>
                    <p className="mt-1">Editing and saving are blocked so the invalid data is not accidentally overwritten. Reset it using revision {revision}, then create a valid mapping.</p>
                  </div>
                ) : savedMapping === null && !conflict && <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">No shop-specific mapping is saved. The labels marked Active or Closed below come from known platform defaults; every other observed label remains <strong>Unknown — review required</strong>. Saving creates this shop’s explicit copy of the rules.</p>}
                {conflict && (
                  <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" role="alert">
                    <p className="font-semibold">This mapping changed after you loaded it.</p>
                    {!conflict.latestLoaded ? (
                      <>
                        <p className="mt-1">Your unsaved draft has been preserved. Reload the latest saved mapping to compare it with your draft before overwriting anything.</p>
                        <button onClick={reloadAfterConflict} disabled={loadingDetails || isMutating} className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-amber-400 bg-white px-3 py-2 text-sm font-medium hover:bg-amber-100 disabled:opacity-40"><RefreshCw className="h-4 w-4" />Reload latest for review</button>
                      </>
                    ) : (
                      <>
                        {invalidStoredMapping ? (
                          <>
                            <p className="mt-1">The latest saved value at revision {revision} is invalid and cannot be displayed safely. Your draft remains preserved. Review this state, then reset the invalid saved value; after reset you will compare the platform default with your draft before saving.</p>
                            <div className="mt-3"><MappingSummary title="Your preserved unsaved draft" mapping={mapping} /></div>
                          </>
                        ) : (
                          <>
                            <p className="mt-1">The latest saved mapping is shown beside your preserved draft. Review every bucket before enabling an overwrite. You may adapt your draft after confirming review; the comparison remains visible.</p>
                            <div className="mt-3 grid gap-3 lg:grid-cols-2">
                              <MappingSummary title={savedMapping ? `Latest saved · revision ${revision}` : `Latest platform default · no saved copy · revision ${revision}`} mapping={savedMapping ? savedMapping : defaultAutoflowWorkflowMapping()} />
                              <MappingSummary title="Your unsaved draft" mapping={mapping} />
                            </div>
                          </>
                        )}
                        {!conflict.reviewed ? (
                          <button onClick={() => setConflict((current) => current ? { ...current, reviewed: true } : current)} className="mt-3 rounded-md bg-amber-800 px-3 py-2 text-sm font-medium text-white hover:bg-amber-900">{invalidStoredMapping ? "I reviewed this invalid saved state" : "I reviewed both mappings"}</button>
                        ) : (
                          <p className="mt-3 font-medium text-amber-900">{invalidStoredMapping ? `Review confirmed. Reset revision ${revision} to repair it without losing your draft.` : `Review confirmed. Saving now will overwrite revision ${revision} with your draft.`}</p>
                        )}
                      </>
                    )}
                  </div>
                )}
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="border-b border-gray-100 text-left text-gray-500"><th className="py-2 pr-3 font-medium">Observed label</th><th className="py-2 pr-3 font-medium">Events</th><th className="py-2 pr-3 font-medium">Last seen</th><th className="py-2 font-medium">Classification</th></tr></thead>
                    <tbody>
                      {observed.length === 0 ? <tr><td colSpan={4} className="py-6 text-center text-gray-500">No workflow labels observed within the configured lookback.</td></tr> : observed.map((item) => {
                        const bucket = assignedBucket(mapping, item.label);
                        return <tr key={normalizeAutoflowWorkflowStatus(item.label)} className="border-b border-gray-50"><td className="py-2.5 pr-3 font-medium text-gray-900">{item.label}</td><td className="py-2.5 pr-3 text-gray-600">{item.count}</td><td className="py-2.5 pr-3 text-gray-600">{formatDate(item.lastSeenAt)}</td><td className="py-2.5"><select value={bucket} disabled={editingDisabled} onChange={(event) => assign(item.label, event.target.value as AutoflowWorkflowBucket | "unknown")} className={`rounded-md border px-2 py-1.5 text-sm disabled:opacity-50 ${bucket === "unknown" ? "border-amber-300 bg-amber-50 text-amber-900" : "border-gray-300 bg-white"}`}><option value="unknown">Unknown — review required</option><option value="active">Active</option><option value="closed">Closed</option><option value="excluded">Excluded</option></select></td></tr>;
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="mt-5 grid gap-3 lg:grid-cols-3">
                  {buckets.map((bucket) => <div key={bucket} className="rounded-lg border border-gray-200 p-3"><h3 className="text-sm font-semibold capitalize text-gray-900">{bucket} rules</h3><p className="mt-1 text-xs text-gray-500">Saved rules not currently observed are retained.</p><div className="mt-3 space-y-1.5">{mapping[bucket].filter((label) => !observedKeys.has(normalizeAutoflowWorkflowStatus(label))).map((label) => <div key={normalizeAutoflowWorkflowStatus(label)} className="flex items-center justify-between gap-2 rounded bg-gray-50 px-2 py-1.5 text-xs"><span className="min-w-0 break-words text-gray-700">{label}</span><button disabled={editingDisabled} onClick={() => assign(label, "unknown")} title={`Remove ${label}`} className="shrink-0 text-gray-400 hover:text-red-600 disabled:opacity-40"><X className="w-3.5 h-3.5" /></button></div>)}</div><div className="mt-3 flex gap-2"><input disabled={editingDisabled} value={newLabel[bucket]} onChange={(event) => setNewLabel((current) => ({ ...current, [bucket]: event.target.value }))} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addLabel(bucket); } }} placeholder="Add saved rule" className="min-w-0 flex-1 border border-gray-300 rounded px-2 py-1.5 text-xs disabled:opacity-50" /><button disabled={editingDisabled} onClick={() => addLabel(bucket)} className="px-2 py-1.5 border border-gray-300 rounded text-xs hover:bg-gray-50 disabled:opacity-40">Add</button></div></div>)}
                </div>
                <div className="mt-5 flex flex-wrap gap-2">
                  <button onClick={save} disabled={isMutating || invalidStoredMapping || reviewRequired} className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-40"><Save className="w-4 h-4" />{saving ? "Saving…" : conflict?.reviewed ? "Overwrite with reviewed draft" : "Save mapping"}</button>
                  <button onClick={reset} disabled={isMutating || reviewRequired || (savedMapping === null && !invalidStoredMapping)} className="inline-flex items-center gap-1.5 rounded-md border border-red-200 px-3 py-2 text-sm text-red-700 hover:bg-red-50 disabled:opacity-40"><RotateCcw className="w-4 h-4" />{resetting ? "Resetting…" : invalidStoredMapping ? "Reset invalid saved mapping" : "Reset saved mapping"}</button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}