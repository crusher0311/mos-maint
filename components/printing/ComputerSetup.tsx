"use client";

import { useEffect, useRef, useState } from "react";
import { printJson } from "./saved-print-client";

type Setup = {
  shopId: number;
  shopName: string;
  canManage: boolean;
  installer: { available: boolean; downloadUrl: string | null; version: string; sha256: string | null };
};

const button = "rounded-lg border px-3 py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-50";

export default function ComputerSetup() {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pairingToken, setPairingToken] = useState<string | null>(null);
  const [pairError, setPairError] = useState("");
  const [busy, setBusy] = useState(false);
  const [approvedShop, setApprovedShop] = useState("");
  const mounted = useRef(false);
  const fragmentRead = useRef(false);
  const request = useRef<AbortController | null>(null);
  const approvalRequest = useRef<AbortController | null>(null);
  const pendingToken = useRef<string | null>(null);

  async function load() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    try {
      const data = await printJson<Setup>("/api/print/setup", { signal: controller.signal });
      if (!mounted.current || controller.signal.aborted) return;
      setSetup(data);
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : "Could not load computer setup.");
      }
    } finally {
      if (mounted.current && !controller.signal.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    if (!fragmentRead.current) {
      fragmentRead.current = true;
      const fragment = window.location.hash.slice(1);
      if (fragment.startsWith("pair=")) {
        window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
        const token = fragment.slice(5);
        if (/^[a-fA-F0-9]{64}$/.test(token)) {
          pendingToken.current = token;
          setPairingToken(token);
        } else {
          setPairError("This connection link is invalid. Return to the setup wizard and choose Connect this computer again.");
        }
      }
    }
    void load();
    return () => {
      mounted.current = false;
      request.current?.abort();
      approvalRequest.current?.abort();
      // Preserve the one-time fragment through React's effect replay, but
      // discard pending approval when this screen is actually left.
      queueMicrotask(() => {
        if (!mounted.current) {
          pendingToken.current = null;
          setPairingToken(null);
        }
      });
    };
  }, []);

  async function confirm() {
    const token = pendingToken.current;
    if (!setup?.canManage || !token || busy || (approvalRequest.current && !approvalRequest.current.signal.aborted)) return;
    const controller = new AbortController();
    approvalRequest.current = controller;
    setBusy(true);
    setPairError("");
    try {
      const result = await printJson<{ shopId: number; shopName: string; approved: true }>("/api/print/setup/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pairingToken: token, shopId: setup.shopId }),
        signal: controller.signal,
      });
      if (!mounted.current || controller.signal.aborted) return;
      if (result.approved !== true || result.shopId !== setup.shopId) throw new Error("The connection could not be confirmed for this shop.");
      pendingToken.current = null;
      setPairingToken(null);
      setApprovedShop(result.shopName);
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) {
        setPairError(cause instanceof Error ? cause.message : "Could not confirm the connection. Please try again.");
      }
    } finally {
      if (approvalRequest.current === controller) approvalRequest.current = null;
      if (mounted.current && !controller.signal.aborted) setBusy(false);
    }
  }

  return <section className="rounded-xl border border-gray-200 bg-white" aria-labelledby="computer-setup-heading">
    <div className="border-b px-6 py-4"><h2 id="computer-setup-heading" className="text-lg font-semibold text-gray-900">Set up this computer</h2></div>
    <div className="space-y-4 p-6">
      {loading ? <div role="status" aria-label="Loading computer setup" className="h-24 animate-pulse rounded-lg bg-gray-100" /> : error ? <div className="space-y-3">
        <p role="alert" className="text-sm text-red-700">{error}</p>
        <button type="button" className={button} onClick={() => void load()}>Retry computer setup</button>
      </div> : setup ? <>
        <p className="text-sm text-gray-600">Connect the shop print agent to {setup.shopName}. Setup does not print labels or change your printing defaults.</p>
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          Windows x64 only. Administrator access is required to install. This pilot installer is unsigned. If Windows security or company policy blocks it, stop rather than bypassing the warning.
        </div>
        {setup.installer.available && setup.installer.downloadUrl ? <div className="space-y-2">
          <a href={setup.installer.downloadUrl} download className={`${button} inline-block`}>Download Windows x64 installer</a>
          <p className="text-xs text-gray-500">Version {setup.installer.version}</p>
          {setup.installer.sha256 && <p className="break-all text-xs text-gray-500">SHA-256: <code>{setup.installer.sha256}</code></p>}
        </div> : <p className="rounded-lg bg-gray-50 p-4 text-sm text-gray-600">The Windows installer has not yet been distributed. No download is available yet. Contact your shop administrator for pilot availability.</p>}
        <ol className="list-decimal space-y-2 pl-5 text-sm text-gray-600">
          <li>Install the shop print agent on this Windows computer.</li>
          <li>Open the setup wizard and choose <span className="font-medium text-gray-900">Connect this computer</span>.</li>
          <li>In the browser, check the shop name and choose <span className="font-medium text-gray-900">Confirm connection</span>.</li>
          <li>Return to the wizard, click Check connection, and confirm the shop. Enroll your printer, enable automatic startup, then open Printing settings to send one calibration label.</li>
        </ol>
        {!setup.canManage && <p className="text-sm text-gray-600">A shop manager must approve this computer’s connection.</p>}
        {pairingToken && <div className="space-y-3 rounded-lg border border-gray-200 bg-gray-50 p-4">
          <h3 className="text-sm font-semibold text-gray-900">Confirm shop: {setup.shopName}</h3>
          <p className="text-sm text-gray-600">Only approve if you just chose Connect this computer in the setup wizard and recognize this shop. Nothing is connected until you confirm.</p>
          <button type="button" className={button} disabled={busy || !setup.canManage} onClick={() => void confirm()}>{busy ? "Confirming connection…" : "Confirm connection"}</button>
          {busy && <p role="status" className="text-sm text-gray-600">Waiting for connection approval.</p>}
        </div>}
      </> : null}
      {pairError && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{pairError}</p>}
      {approvedShop && <p role="status" className="rounded-lg border bg-gray-50 p-3 text-sm text-gray-700">Connection approved for {approvedShop}. Return to the setup wizard to enroll and calibrate your printer.</p>}
    </div>
  </section>;
}
