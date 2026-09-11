"use client";

import React, { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

const ENDPOINT = "/api/platform-admin/protractor-operator-stop";
const STATUS_POLL_MS = 15_000;
const TRIAL_DURATION_MINUTES = 30;
const DEFAULT_TRIAL_SCOPE = "callbacks" as const;

type TrialScope = "callbacks" | "callbacks_and_interactive";

type AuditEntry = {
  event?: string;
  at?: string;
  endedBy?: string;
  [key: string]: unknown;
};

type Canary = {
  mode?: "bounded" | "timed_trial" | string;
  scope?: TrialScope | string | null;
  generation?: string;
  startedAt?: string | Date | null;
  expiresAt?: string | Date | null;
  maxAdmissions?: number | null;
  consumedAdmissions?: number;
  remainingAdmissions?: number | null;
  endedBy?: string | null;
  audit?: AuditEntry[];
};

type OperatorStopState = {
  active?: boolean;
  stopId?: string | null;
  physicalAdmissionInFlight?: boolean;
  canary?: Canary | null;
  canaryHistory?: Canary[];
};

type StatusPayload = {
  ok?: boolean;
  state?: OperatorStopState;
  trialReady?: boolean;
  trialUnavailableReason?: string;
  error?: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timestamp(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value instanceof Date ? value.getTime() : value);
  if (Number.isNaN(date.getTime())) return "Invalid timestamp";
  return date.toLocaleString();
}

function remainingMilliseconds(expiresAt: string | Date | null | undefined, now: number): number | null {
  if (!expiresAt) return null;
  const expires = new Date(expiresAt instanceof Date ? expiresAt.getTime() : expiresAt).getTime();
  if (!Number.isFinite(expires)) return null;
  return Math.max(0, expires - now);
}

function countdown(milliseconds: number | null): string {
  if (milliseconds === null) return "—";
  if (milliseconds === 0) return "Expired";
  const totalSeconds = Math.ceil(milliseconds / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`
    : `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function parsePayload(raw: unknown): StatusPayload {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "The operator-stop API returned an invalid response." };
  }
  return raw as StatusPayload;
}

function canaryLabel(canary: Canary | null | undefined): string {
  if (!canary) return "No generation";
  if (canary.mode === "timed_trial") return "Timed trial";
  if (canary.mode === "bounded") return "Bounded generation";
  return canary.mode || "Generation";
}

function scopeLabel(scope: Canary["scope"]): string {
  if (scope === "callbacks_and_interactive") {
    return "All shops: callbacks + normal staff activity";
  }
  if (scope === "callbacks" || !scope) {
    return "Callback-only (legacy default)";
  }
  return `Unknown scope (${scope})`;
}

export default function ProtractorOperatorStopClient() {
  const [state, setState] = useState<OperatorStopState | null>(null);
  const [trialReady, setTrialReady] = useState<boolean | null>(null);
  const [trialUnavailableReason, setTrialUnavailableReason] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [trialReason, setTrialReason] = useState("");
  const [trialScope, setTrialScope] = useState<TrialScope>(DEFAULT_TRIAL_SCOPE);
  const [emergencyReason, setEmergencyReason] = useState("");
  const [workersSuspendedConfirmed, setWorkersSuspendedConfirmed] = useState(false);
  const [startingTrial, setStartingTrial] = useState(false);
  const [activatingEmergency, setActivatingEmergency] = useState(false);

  const invalidateReadiness = useCallback((reason: string) => {
    setTrialReady(null);
    setTrialUnavailableReason(reason);
  }, []);

  const applyStatus = useCallback((payload: StatusPayload, requireReadiness = false) => {
    if (payload.state) setState(payload.state);
    if (typeof payload.trialReady === "boolean") {
      setTrialReady(payload.trialReady);
    } else if (requireReadiness) {
      invalidateReadiness("Status response did not include trial readiness.");
    }
    if (payload.trialUnavailableReason !== undefined) {
      setTrialUnavailableReason(payload.trialUnavailableReason || null);
    } else if (payload.trialReady === true) {
      setTrialUnavailableReason(null);
    }
    setLastUpdated(new Date());
  }, [invalidateReadiness]);

  const refreshStatus = useCallback(async (showError = true): Promise<StatusPayload | null> => {
    setRefreshing(true);
    try {
      const response = await fetch(ENDPOINT, {
        method: "GET",
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      let payload: StatusPayload;
      try {
        payload = parsePayload(await response.json());
      } catch {
        throw new Error(`Status request returned unreadable JSON (HTTP ${response.status}).`);
      }
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || `Status request failed (HTTP ${response.status}).`);
      }
      if (!payload.state) {
        throw new Error("Status request did not include operator-stop state.");
      }
      applyStatus(payload, true);
      setError(null);
      return payload;
    } catch (caught) {
      invalidateReadiness("Readiness is unknown until a fresh status response succeeds.");
      if (showError) setError(errorMessage(caught));
      return null;
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [applyStatus, invalidateReadiness]);

  useEffect(() => {
    void refreshStatus();
    const poll = window.setInterval(() => {
      void refreshStatus();
    }, STATUS_POLL_MS);
    return () => window.clearInterval(poll);
  }, [refreshStatus]);

  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(clock);
  }, []);

  const currentCanary = state?.canary ?? null;
  const remaining = remainingMilliseconds(currentCanary?.expiresAt, now);
  const terminalReason = currentCanary?.endedBy || (remaining === 0 ? "time" : null);
  const stopId = state?.stopId?.trim() || "";
  const canStartTrial =
    state?.active === true &&
    trialReady === true &&
    Boolean(stopId) &&
    Boolean(trialReason.trim()) &&
    workersSuspendedConfirmed &&
    !startingTrial &&
    !activatingEmergency;

  const readinessText = trialReady === true ? "Ready" : trialReady === false ? "Not ready" : "Unavailable";
  const readinessClass =
    trialReady === true
      ? "bg-green-100 text-green-800"
      : trialReady === false
        ? "bg-red-100 text-red-800"
        : "bg-slate-100 text-slate-700";

  const trialStateText = useMemo(() => {
    if (!currentCanary) return "No generation is open.";
    if (currentCanary.endedBy) {
      return state?.active
        ? `Operator stop is active; this generation is terminal (${currentCanary.endedBy}).`
        : `Timed generation is terminal (${currentCanary.endedBy}) and was not reopened.`;
    }
    if (currentCanary.mode === "timed_trial" && remaining === 0) {
      return "Timed trial expired. This generation is terminal and was not reopened.";
    }
    if (state?.active) return "Operator stop is active; timed trial is contained and not live.";
    if (currentCanary.mode === "timed_trial") return "Timed trial is live.";
    if (currentCanary.mode === "bounded") return "An existing bounded generation is visible.";
    return "A generation is visible.";
  }, [currentCanary, remaining, state?.active]);

  async function freshStatusAfterConflict(message: string): Promise<void> {
    const fresh = await refreshStatus(false);
    if (fresh) {
      setError(`${message} Status was refreshed. Review the fresh stop ID; nothing was retried.`);
    } else {
      setError(`${message} The fresh status fetch also failed. Do not retry until status is confirmed.`);
    }
  }

  async function uncertainAction(message: string): Promise<void> {
    const fresh = await refreshStatus(false);
    if (fresh) {
      setError(`${message} Status was fetched to determine the outcome. Do not retry automatically.`);
    } else {
      setError(`${message} The status fetch also failed. Do not retry until status is confirmed.`);
    }
  }

  async function startTrial(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canStartTrial) {
      setError("The timed trial cannot start until an active stop, readiness, reason, and both confirmations are present.");
      return;
    }

    setStartingTrial(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          action: "start_trial",
          reason: trialReason.trim(),
          scope: trialScope,
          expectedStopId: stopId,
          workersSuspendedConfirmed: true,
        }),
      });
      let payload: StatusPayload;
      try {
        payload = parsePayload(await response.json());
      } catch {
        await uncertainAction("The trial response could not be read; its outcome is uncertain.");
        return;
      }
      if (response.status === 409) {
        await freshStatusAfterConflict(payload.error || "The stop changed while starting the trial.");
        return;
      }
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || `Timed trial start failed (HTTP ${response.status}).`);
      }
      if (!payload.state) {
        await uncertainAction("The trial start response did not include fresh state; its outcome is uncertain.");
        return;
      }
      applyStatus(payload);
      setTrialReason("");
      setTrialScope(DEFAULT_TRIAL_SCOPE);
      setWorkersSuspendedConfirmed(false);
      setNotice("Timed trial started for the fixed 30-minute window. Mongo activation is the start time.");
    } catch (caught) {
      if (caught instanceof TypeError) {
        await uncertainAction("The trial start request may have reached the server, but the network outcome is uncertain.");
      } else {
        invalidateReadiness("Readiness is unknown until a fresh status response succeeds.");
        setError(errorMessage(caught));
      }
    } finally {
      setStartingTrial(false);
    }
  }

  async function activateEmergency(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const reason = emergencyReason.trim();
    if (!reason) {
      setError("An emergency activation reason is required.");
      return;
    }

    setActivatingEmergency(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ action: "activate", reason }),
      });
      let payload: StatusPayload;
      try {
        payload = parsePayload(await response.json());
      } catch {
        await uncertainAction("The emergency activation response could not be read; its outcome is uncertain.");
        return;
      }
      if (response.status === 409) {
        await freshStatusAfterConflict(payload.error || "The operator stop changed during emergency activation.");
        return;
      }
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error || `Emergency activation failed (HTTP ${response.status}).`);
      }
      if (!payload.state) {
        await uncertainAction("The emergency response did not include fresh state; its outcome is uncertain.");
        return;
      }
      applyStatus(payload);
      setEmergencyReason("");
      setNotice("Emergency operator stop activated. No generation was automatically reopened.");
    } catch (caught) {
      if (caught instanceof TypeError) {
        await uncertainAction("The emergency activation request may have reached the server, but the network outcome is uncertain.");
      } else {
        invalidateReadiness("Readiness is unknown until a fresh status response succeeds.");
        setError(errorMessage(caught));
      }
    } finally {
      setActivatingEmergency(false);
    }
  }

  if (loading && !state) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold text-gray-900">Protractor Timed Live Trial</h1>
        <p className="mt-2 text-sm text-gray-600">Loading operator-stop status…</p>
        {error && <ErrorNotice message={error} />}
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <header>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Protractor Timed Live Trial</h1>
            <p className="mt-1 max-w-3xl text-sm text-gray-600">
              Production-only operator control. The trial always runs for exactly 30 minutes after
              Mongo activation; the operator cannot select a duration or request cap.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void refreshStatus()}
            disabled={refreshing || startingTrial || activatingEmergency}
            className="rounded border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {refreshing ? "Refreshing…" : "Refresh status"}
          </button>
        </div>
        {lastUpdated && (
          <p className="mt-2 text-xs text-gray-500">Last status update: {lastUpdated.toLocaleString()}</p>
        )}
      </header>

      <div className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-900">
        <p className="font-semibold">Production-only control</p>
        <p className="mt-1">
          Do not use this page for synthetic traffic or experimentation. Keep both workers suspended
          and historical backfill off for the complete trial. Expired generations are terminal.
        </p>
      </div>

      {error && <ErrorNotice message={error} />}
      {notice && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800" role="status">
          {notice}
        </div>
      )}

      <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Operator-stop status</h2>
            <p className="mt-1 text-sm text-gray-500">
              The stop is the physical admission gate. A live generation never removes production pacers or breakers.
            </p>
          </div>
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${state?.active ? "bg-red-100 text-red-800" : "bg-green-100 text-green-800"}`}>
            {state?.active ? "STOP ACTIVE" : "STOP CLEARED"}
          </span>
        </div>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <StatusField label="Stop ID" value={stopId || "Not reported"} mono />
          <StatusField label="Physical admission in flight" value={state?.physicalAdmissionInFlight === undefined ? "Not reported" : state.physicalAdmissionInFlight ? "Yes" : "No"} />
          <StatusField label="Trial readiness" value={readinessText} valueClass={trialReady === true ? "text-green-700" : trialReady === false ? "text-red-700" : "text-gray-700"} />
          <StatusField label="Current generation" value={canaryLabel(currentCanary)} />
        </dl>
        <div className="mt-4 rounded border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
          <span className={`mr-2 inline-block rounded-full px-2 py-0.5 font-semibold ${readinessClass}`}>{readinessText}</span>
          Readiness is configuration-only. This page does not independently verify worker state or historical backfill state.
          {trialUnavailableReason && <span className="ml-1 font-medium">Reason: {trialUnavailableReason}</span>}
        </div>
      </section>

      <section className="rounded-lg border border-blue-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Start the timed trial</h2>
            <p className="mt-1 text-sm text-gray-600">
              Start is available only while the emergency stop is active and the API reports trial-ready.
              The API starts exactly 30 minutes on Mongo activation. There is no duration or cap input.
            </p>
          </div>
          <span className="rounded-full bg-blue-100 px-3 py-1 text-xs font-semibold text-blue-800">30 minutes · timed</span>
        </div>

        <form onSubmit={startTrial} className="mt-5 space-y-4">
          <div>
            <label htmlFor="trial-reason" className="block text-sm font-medium text-gray-800">
              Trial reason
            </label>
            <textarea
              id="trial-reason"
              value={trialReason}
              onChange={(event) => setTrialReason(event.target.value)}
              rows={3}
              maxLength={1_000}
              placeholder="Describe the approved production maintenance window and owner."
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <fieldset className="rounded border border-blue-200 bg-blue-50 p-3">
            <legend className="px-1 text-sm font-semibold text-gray-900">Trial scope</legend>
            <div className="mt-1 space-y-3 text-sm">
              <label className="flex items-start gap-3">
                <input
                  type="radio"
                  name="trial-scope"
                  value="callbacks"
                  checked={trialScope === "callbacks"}
                  onChange={() => setTrialScope("callbacks")}
                  className="mt-0.5 h-4 w-4 border-gray-400"
                />
                <span>
                  <strong>Callback-only (default)</strong>
                  <span className="mt-0.5 block text-xs text-gray-700">
                    Legacy scope: organic provider callbacks only.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-3">
                <input
                  type="radio"
                  name="trial-scope"
                  value="callbacks_and_interactive"
                  checked={trialScope === "callbacks_and_interactive"}
                  onChange={() => setTrialScope("callbacks_and_interactive")}
                  className="mt-0.5 h-4 w-4 border-gray-400"
                />
                <span>
                  <strong>All shops: callbacks + normal staff activity</strong>
                  <span className="mt-0.5 block text-xs text-gray-700">
                    Fleet-wide across all connected, non-canceled Protractor shops; there is no
                    per-shop selection.
                  </span>
                </span>
              </label>
            </div>
            <p className="mt-3 border-t border-blue-200 pt-3 text-xs text-blue-900">
              All-shops scope still excludes unattended cron/background work and automatic post-request
              refreshes. It is not full worker or historical-backfill traffic. Both workers remain
              suspended and historical backfill stays off in either scope.
            </p>
          </fieldset>
          <label className="flex items-start gap-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <input
              type="checkbox"
              checked={workersSuspendedConfirmed}
              onChange={(event) => setWorkersSuspendedConfirmed(event.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-gray-400"
            />
            <span>
              I manually confirm that <strong>both Protractor workers are suspended</strong> and
              <strong> historical backfill is off</strong> for this trial.
              <span className="mt-1 block text-xs text-amber-800">
                This is an operator attestation; readiness is not independently verified by this UI.
              </span>
            </span>
          </label>
          <button
            type="submit"
            disabled={!canStartTrial}
            className="rounded bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {startingTrial ? "Starting trial…" : "Start 30-minute timed trial"}
          </button>
          {state?.active !== true && (
            <p className="text-xs text-gray-600">An active operator stop is required before this action is enabled.</p>
          )}
          {trialReady !== true && (
            <p className="text-xs text-gray-600">
              The start action stays disabled until the API reports readiness. No readiness fallback is assumed.
            </p>
          )}
        </form>
      </section>

      <section className="rounded-lg border border-amber-300 bg-white p-5 shadow-sm">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Emergency activation</h2>
          <p className="mt-1 text-sm text-gray-600">
            Activate the emergency stop with a reason at any time, including while a timed generation is live.
            This action is never automatic and does not reopen or extend an expired generation.
          </p>
        </div>
        <form onSubmit={activateEmergency} className="mt-4 space-y-3">
          <label htmlFor="emergency-reason" className="block text-sm font-medium text-gray-800">
            Emergency reason
          </label>
          <textarea
            id="emergency-reason"
            value={emergencyReason}
            onChange={(event) => setEmergencyReason(event.target.value)}
            rows={2}
            maxLength={1_000}
            placeholder="Explain why all new physical admissions must stop now."
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
          />
          <button
            type="submit"
            disabled={activatingEmergency || startingTrial || !emergencyReason.trim()}
            className="rounded bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {activatingEmergency ? "Activating stop…" : "Activate emergency operator stop"}
          </button>
        </form>
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Current trial telemetry</h2>
            <p className="mt-1 text-sm text-gray-600">{trialStateText}</p>
          </div>
          {currentCanary?.mode === "timed_trial" && (
            <div className="text-right">
              <div className="text-xs uppercase tracking-wide text-gray-500">Remaining clock (advisory)</div>
              <div className={`font-mono text-2xl font-bold ${remaining === 0 ? "text-gray-500" : "text-blue-700"}`}>
                {countdown(remaining)}
              </div>
            </div>
          )}
        </div>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <StatusField label="Mode" value={canaryLabel(currentCanary)} />
          <StatusField label="Started" value={timestamp(currentCanary?.startedAt)} />
          <StatusField label="Expires" value={timestamp(currentCanary?.expiresAt)} />
          <StatusField label="Terminal reason" value={terminalReason || "Still live / not reported"} />
          <StatusField label="Consumed requests" value={currentCanary?.consumedAdmissions === undefined ? "Not reported" : String(currentCanary.consumedAdmissions)} />
           <StatusField label="Scope" value={currentCanary ? scopeLabel(currentCanary.scope) : "No generation"} />
          <StatusField
            label="Remaining requests"
            value={
              currentCanary?.mode === "timed_trial" && currentCanary.maxAdmissions == null
                ? "No cap (time-limited)"
                : currentCanary?.remainingAdmissions === undefined || currentCanary.remainingAdmissions === null
                  ? "Not reported"
                  : String(currentCanary.remainingAdmissions)
            }
          />
          <StatusField label="Max requests" value={currentCanary?.maxAdmissions === undefined ? "Not reported" : currentCanary.maxAdmissions === null ? "No cap" : String(currentCanary.maxAdmissions)} />
          <StatusField label="Generation" value={currentCanary?.generation || "Not reported"} mono />
        </dl>
        {currentCanary?.mode === "timed_trial" && currentCanary.maxAdmissions == null && (
          <p className="mt-4 rounded border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
            Timed mode has no request cap, but it is strictly time-limited—not unguarded. Production pacers and
            circuit breakers remain in force.
          </p>
        )}
        {currentCanary?.mode === "bounded" && (
          <p className="mt-4 rounded border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700">
            This UI does not create bounded generations. Existing 1–3 admission bounded mode remains visible and
            is retained by the API.
          </p>
        )}
        <AuditTable audit={currentCanary?.audit} />
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-900">Canary history</h2>
        <p className="mt-1 text-sm text-gray-600">Completed generations are read-only. Expired generations never reopen.</p>
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-gray-200 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-2 py-2">Mode</th>
                <th className="px-2 py-2">Scope</th>
                <th className="px-2 py-2">Started</th>
                <th className="px-2 py-2">Expired</th>
                <th className="px-2 py-2">Requests</th>
                <th className="px-2 py-2">Ended by</th>
                <th className="px-2 py-2">Generation</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(state?.canaryHistory ?? []).map((historyCanary, index) => (
                <tr key={historyCanary.generation || `${historyCanary.startedAt || "generation"}-${index}`}>
                  <td className="px-2 py-2">{canaryLabel(historyCanary)}</td>
                   <td className="px-2 py-2">{scopeLabel(historyCanary.scope)}</td>
                  <td className="px-2 py-2 whitespace-nowrap">{timestamp(historyCanary.startedAt)}</td>
                  <td className="px-2 py-2 whitespace-nowrap">{timestamp(historyCanary.expiresAt)}</td>
                  <td className="px-2 py-2">{historyCanary.consumedAdmissions ?? "Not reported"}</td>
                  <td className="px-2 py-2">{historyCanary.endedBy || "Not reported"}</td>
                  <td className="px-2 py-2 font-mono text-xs">{historyCanary.generation || "Not reported"}</td>
                </tr>
              ))}
              {(state?.canaryHistory ?? []).length === 0 && (
                <tr>
                   <td colSpan={7} className="px-2 py-4 text-center text-sm text-gray-500">
                    No completed generations reported.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function ErrorNotice({ message }: { message: string }) {
  return (
    <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800" role="alert">
      {message}
    </div>
  );
}

function StatusField({
  label,
  value,
  mono = false,
  valueClass = "text-gray-900",
}: {
  label: string;
  value: string;
  mono?: boolean;
  valueClass?: string;
}) {
  return (
    <div className="rounded border border-gray-100 bg-gray-50 p-3">
      <dt className="text-xs uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className={`mt-1 break-words font-medium ${mono ? "font-mono text-xs" : ""} ${valueClass}`}>{value}</dd>
    </div>
  );
}

function AuditTable({ audit }: { audit?: AuditEntry[] }) {
  if (!audit || audit.length === 0) return null;
  return (
    <details className="mt-4">
      <summary className="cursor-pointer text-sm font-medium text-gray-700">Audit trail ({audit.length})</summary>
      <div className="mt-2 overflow-x-auto rounded border border-gray-200">
        <table className="min-w-full text-left text-xs">
          <thead className="border-b border-gray-200 bg-gray-50 text-gray-500">
            <tr>
              <th className="px-2 py-2">Event</th>
              <th className="px-2 py-2">At</th>
              <th className="px-2 py-2">Ended by</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {audit.map((entry, index) => (
              <tr key={`${entry.event || "event"}-${entry.at || index}`}>
                <td className="px-2 py-2 font-medium">{entry.event || "Not reported"}</td>
                <td className="px-2 py-2 whitespace-nowrap">{timestamp(entry.at)}</td>
                <td className="px-2 py-2">{entry.endedBy || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}