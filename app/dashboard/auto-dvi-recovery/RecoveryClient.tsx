"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

type Stage = "packages" | "findings";
type Reply = Record<string, unknown>;
type Grant = { id: string; operationId: string; stage: Stage; expiresAt: number; packages: string; selectedStage: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const button = "rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600";
const secondary = "rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600";
const input = "mt-1 block w-full rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-900 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:opacity-60";
const fields = [
  ["operationState", "Operation", ["prepared", "in_progress", "verification_required", "conflict", "provider_verified", "complete"]],
  ["packageStatus", "Packages", ["prepared", "admitted", "acknowledged", "verified", "uncertain", "conflict", "not_requested"]],
  ["resultsStatus", "Findings", ["prepared", "admitted", "acknowledged", "verified", "uncertain", "conflict", "not_requested"]],
  ["readBackStatus", "Read-back", ["verified", "conflict", "unavailable"]],
  ["localReceiptStatus", "Local receipt", ["recorded", "confirmed", "unconfirmed", "complete", "pending", "repaired"]],
  ["outcome", "Outcome", ["uncertain", "complete", "success", "verified"]],
] as const;

function apiError(body: Reply): string {
  const code = typeof body.error === "string" ? body.error : "";
  const messages: Record<string, string> = {
    OPERATOR_AUTHORIZATION_REQUIRED: "Operator capability is missing or expired. Ask an administrator to review access.",
    OPERATION_FORBIDDEN: "Live shop membership or Auto DVI access could not be verified.",
    UNAUTHORIZED: "Your session cannot perform this action. Sign in with an authorized account.",
    NOT_FOUND: "No tracked operation was found for this ID.",
    DURABLE_NOT_ENROLLED: "This shop is not enrolled for tracked Auto DVI operations.",
    MANUAL_RESOLUTION_REQUIRED: "This operation requires manual resolution. Do not resend.",
    EARLIER_REQUEST_UNRESOLVED: "An earlier request may still execute. Manual verification is required; do not resend.",
    RECONCILE_REQUIRED: "Reconcile the operation before considering recovery.",
    PROVIDER_EDIT: "Provider data has changed. Stop and resolve this manually.",
    STAGE_NOT_RECOVERABLE: "This stage cannot be recovered.",
    PACKAGES_UNVERIFIED: "Packages must be verified before findings can be recovered.",
    OPERATION_CHANGED: "The operation changed. Check status and reconcile.",
    OPERATION_BUSY: "The operation is busy. Check status; do not resend.",
    GRANT_INVALID: "Authorization is no longer valid. Check status and reconcile.",
  };
  return messages[code] ?? "The request was not accepted. Check status or reconcile before proceeding.";
}

async function request(url: string, method: "GET" | "POST", body?: Reply) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch(url, {
      method, credentials: "include", cache: "no-store", signal: controller.signal,
      ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    const parsed: unknown = await response.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid response");
    return { ok: response.ok, body: parsed as Reply };
  } finally {
    clearTimeout(timer);
  }
}

export default function RecoveryClient() {
  const [lookupBy, setLookupBy] = useState<"operationId" | "workOrderGuid">("operationId");
  const [identifier, setIdentifier] = useState("");
  const [stage, setStage] = useState<Stage>("packages");
  const [status, setStatus] = useState<Reply | null>(null);
  const [grant, setGrant] = useState<Grant | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const sending = useRef(false);
  // A consume attempt is never repeated from this mounted operator session,
  // even if the response is lost or the lookup fields are changed.
  const attempted = useRef(new Set<string>());
  const operationId = typeof status?.operationId === "string" && uuid.test(status.operationId) ? status.operationId : null;
  const blocked = !!operationId && attempted.current.has(operationId);

  function clearGrant() { setGrant(null); setConfirmed(false); }
  function resetLookup() { clearGrant(); setStatus(null); setError(""); setNotice(""); }

  useEffect(() => {
    if (!grant) return;
    const expire = () => {
      setGrant(null);
      setConfirmed(false);
      setNotice("Authorization expired. Nothing was sent. Check status before requesting a new review.");
    };
    const timer = setTimeout(expire, Math.max(0, grant.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [grant]);

  async function run(action: "lookup" | "reconcile" | "authorize" | "consume") {
    if (sending.current) return;
    if (action === "lookup" && !uuid.test(identifier.trim())) {
      setError("Enter a valid UUID.");
      return;
    }
    if (action !== "lookup" && !operationId) return;
    if ((action === "authorize" || action === "consume") && blocked) return;
    const saved = grant;
    if (action === "consume" && (!confirmed || !saved || saved.operationId !== operationId || saved.stage !== stage)) return;
    if (action === "consume" && saved!.expiresAt <= Date.now()) {
      clearGrant();
      setError("Authorization expired. Nothing was sent. Check status before requesting a new review.");
      return;
    }
    sending.current = true;
    setBusy(action);
    setError("");
    setNotice("");
    clearGrant();
    if (action === "consume") attempted.current.add(operationId!);
    try {
      const result = action === "lookup" || action === "reconcile"
        ? await request(`/api/auto-dvi/push/status?${new URLSearchParams(action === "lookup"
          ? { [lookupBy]: identifier.trim().toLowerCase() } : { operationId: operationId! })}`, action === "lookup" ? "GET" : "POST")
        : await request("/api/auto-dvi/push/recover", "POST", {
          action, operationId, stage, ...(action === "consume" ? { grantId: saved!.id } : {}),
        });
      if (action === "consume") {
        setStatus(result.body);
        setNotice("The one-time send was attempted. Use read-only status or reconcile to verify the outcome. Do not resend.");
      }
      if (!result.ok) {
        if (action === "lookup" || action === "reconcile") setStatus(result.body);
        setError(apiError(result.body));
        return;
      }
      if (action === "authorize" && result.body.operationState !== "complete") {
        const body = result.body;
        const review = body.review as Reply | undefined;
        if (typeof body.grantId !== "string" || !uuid.test(body.grantId) ||
            body.operationId !== operationId || body.stage !== stage ||
            typeof body.expiresAt !== "number" || !Number.isFinite(body.expiresAt) || body.expiresAt <= Date.now() ||
            !review || review.selectedStage !== "baseline_unchanged" ||
            !["verified_unchanged", "baseline_unchanged"].includes(String(review.packages))) {
          throw new Error("Invalid authorization response");
        }
        setGrant({ id: body.grantId, operationId: operationId!, stage, expiresAt: body.expiresAt,
          packages: String(review.packages), selectedStage: "baseline unchanged" });
        setNotice("Review ready. No provider send has been made by this authorization.");
      } else {
        setStatus(result.body);
        if (action !== "consume") setNotice(result.body.operationState === "complete"
          ? "Operation complete. No recovery send is needed."
          : action === "reconcile" ? "Read-only reconciliation finished. No saved stage was sent."
          : result.body.operationId === null ? "No tracked operation. Historical uncertain pushes require manual verification; do not resend."
          : "Status loaded. Pending (202) is a normal result; it does not authorize a send.");
      }
    } catch {
      setError(action === "consume"
        ? "The send response was lost or could not be verified. It may have reached the provider. Do not resend or request another authorization. Use read-only status or reconcile only."
        : "The response could not be verified. No automatic retry will occur. Check your connection and use status or reconcile.");
    } finally {
      sending.current = false;
      setBusy("");
    }
  }

  function lookup(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void run("lookup"); }

  return (
    <div className="space-y-5">
      <form onSubmit={lookup} className="space-y-4 rounded-lg border border-slate-200 p-5">
        <h2 className="font-semibold text-slate-900">1. Find a tracked operation</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-medium text-slate-700">Look up by
            <select className={input} value={lookupBy} disabled={!!busy} onChange={e => { resetLookup(); setIdentifier(""); setLookupBy(e.target.value as typeof lookupBy); }}>
              <option value="operationId">Operation ID</option><option value="workOrderGuid">Work order GUID</option>
            </select>
          </label>
          <label className="text-sm font-medium text-slate-700">UUID
            <input className={input} value={identifier} required spellCheck={false} autoComplete="off" disabled={!!busy}
              onChange={e => { resetLookup(); setIdentifier(e.target.value); }} aria-describedby="lookup-help" />
          </label>
        </div>
        <p id="lookup-help" className="text-sm text-slate-500">Status lookup does not send anything to the provider.</p>
        <button className={button} disabled={!!busy || !identifier.trim()} type="submit">Check status</button>
      </form>
      <div aria-live="polite" role="status" className="text-sm text-slate-700">
        {busy ? <p className="animate-pulse rounded-md bg-slate-100 p-3">{busy === "consume" ? "Submitting the saved stage once. Do not resend…" : "Waiting for the operator request…"}</p> : notice}
      </div>
      {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
      {status && (
        <section aria-labelledby="status-heading" className="space-y-4 rounded-lg border border-slate-200 p-5">
          <h2 id="status-heading" className="font-semibold text-slate-900">Operation status</h2>
          {operationId && <p className="break-all font-mono text-sm text-slate-600">{operationId}</p>}
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            {fields.map(([key, label, allowed]) => {
              const value = status[key];
              return typeof value === "string" && (allowed as readonly string[]).includes(value)
                ? <div key={key}><dt className="text-slate-500">{label}</dt><dd className="font-medium text-slate-800">{value.replaceAll("_", " ")}</dd></div> : null;
            })}
          </dl>
          {operationId && <>
            <button type="button" className={secondary} disabled={!!busy} onClick={() => void run("reconcile")}>Reconcile (no provider send)</button>
            <p className="text-sm text-slate-500">Reads provider state and repairs local receipts only. It never resends a stage.</p>
          </>}
        </section>
      )}
      {operationId && status?.operationState !== "complete" && (
        <section aria-labelledby="recovery-heading" className="space-y-4 rounded-lg border border-slate-200 p-5">
          <h2 id="recovery-heading" className="font-semibold text-slate-900">2. Review one saved stage</h2>
          {blocked ? <p className="text-sm text-amber-900">A send has already been attempted for this operation in this session. Only check status or reconcile; do not resend.</p> : <>
            <label className="block text-sm font-medium text-slate-700">Stage
              <select className={input} value={stage} disabled={!!busy} onChange={e => { clearGrant(); setStage(e.target.value as Stage); setNotice(""); setError(""); }}>
                <option value="packages">Packages</option><option value="findings">Findings</option>
              </select>
            </label>
            <p className="text-sm text-slate-500">Request a short-lived review first. Authorization may repair receipts but does not send a saved stage. The server checks whether this stage is eligible.</p>
            <button type="button" className={secondary} disabled={!!busy || !!grant} onClick={() => void run("authorize")}>Authorize review only</button>
            {grant && <div className="space-y-3 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
              <h3 className="font-semibold">3. Explicitly confirm the saved {grant.stage} stage</h3>
              <p>Packages: {grant.packages.replaceAll("_", " ")}. Selected stage: {grant.selectedStage}.</p>
              <p>Send only this saved stage with its original IDs. Authorization expires at {new Date(grant.expiresAt).toLocaleTimeString()}; it is not saved across page changes.</p>
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-1 h-4 w-4" checked={confirmed} disabled={!!busy} onChange={e => setConfirmed(e.target.checked)} />
                <span>I reviewed the operation and stage. I understand this sends the saved {grant.stage} stage once, not the whole inspection.</span>
              </label>
              <div className="flex flex-wrap gap-3">
                <button type="button" className={button} disabled={!confirmed || !!busy} onClick={() => void run("consume")}>Confirm and send saved {grant.stage} once</button>
                <button type="button" className={secondary} disabled={!!busy} onClick={() => { clearGrant(); setNotice("Review dismissed. Nothing was sent."); }}>Cancel review</button>
              </div>
            </div>}
          </>}
        </section>
      )}
    </div>
  );
}
