"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { QrCode, Copy, RefreshCw, Loader2, Check, Download, X } from "lucide-react";

interface EnrollmentState {
  enabled: boolean;
  code: string | null;
  mode: "instant" | "approval";
  defaultRole: "user" | "viewer";
  rotatedAt: string | null;
  autoApproveDomains: string[];
  joinUrl: string | null;
}

export default function EnrollmentSection() {
  const [state, setState] = useState<EnrollmentState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [domainInput, setDomainInput] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/settings/enrollment");
        if (res.ok) {
          const data = await res.json();
          setState(data.enrollment);
        }
      } catch {
        // silent — section just won't render controls
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (state?.joinUrl && state.enabled) {
      QRCode.toDataURL(state.joinUrl, { width: 320, margin: 2 })
        .then((url) => {
          if (!cancelled) setQrDataUrl(url);
        })
        .catch(() => setQrDataUrl(null));
    } else {
      setQrDataUrl(null);
    }
    return () => {
      cancelled = true;
    };
  }, [state?.joinUrl, state?.enabled]);

  async function update(
    patch: Partial<Pick<EnrollmentState, "enabled" | "mode" | "defaultRole" | "autoApproveDomains">>
  ) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/enrollment", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        setState(data.enrollment);
      } else {
        setError(data?.error || "Failed to save");
      }
    } catch {
      setError("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function rotate() {
    if (
      !confirm(
        "Rotate the enrollment code? The current code and QR will stop working immediately — anyone with the old link won't be able to join."
      )
    )
      return;
    setRotating(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/enrollment", { method: "POST" });
      const data = await res.json().catch(() => null);
      if (res.ok && data?.ok) {
        setState((prev) =>
          prev ? { ...prev, code: data.code, joinUrl: data.joinUrl, rotatedAt: new Date().toISOString() } : prev
        );
      } else {
        setError(data?.error || "Failed to rotate code");
      }
    } catch {
      setError("Failed to rotate code");
    } finally {
      setRotating(false);
    }
  }

  function addDomains() {
    if (!state) return;
    const parsed = domainInput
      .split(/[\s,;]+/)
      .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
      .filter(Boolean);
    if (parsed.length === 0) return;
    const merged = Array.from(new Set([...state.autoApproveDomains, ...parsed]));
    setDomainInput("");
    update({ autoApproveDomains: merged });
  }

  function removeDomain(domain: string) {
    if (!state) return;
    update({ autoApproveDomains: state.autoApproveDomains.filter((d) => d !== domain) });
  }

  async function copyLink() {
    if (!state?.joinUrl) return;
    try {
      await navigator.clipboard.writeText(state.joinUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  if (loading) {
    return (
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 flex justify-center">
        <Loader2 className="w-5 h-5 animate-spin text-blue-600" />
      </div>
    );
  }
  if (!state) return null;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-indigo-100 rounded-lg">
            <QrCode className="w-5 h-5 text-indigo-600" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Enrollment Code</h2>
            <p className="text-sm text-gray-500">
              Let staff scan a QR code to join this location themselves
            </p>
          </div>
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <span className="text-sm text-gray-600">{state.enabled ? "Enabled" : "Disabled"}</span>
          <input
            type="checkbox"
            checked={state.enabled}
            disabled={saving}
            onChange={(e) => update({ enabled: e.target.checked })}
            className="w-4 h-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
          />
        </label>
      </div>

      {error && (
        <div className="mx-6 mt-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3">
          {error}
        </div>
      )}

      {state.enabled && state.code && (
        <div className="p-6 grid md:grid-cols-2 gap-6">
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Join link</label>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={state.joinUrl || ""}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg bg-gray-50 text-sm text-gray-700"
                  onFocus={(e) => e.target.select()}
                />
                <button
                  onClick={copyLink}
                  className="p-2 text-gray-500 hover:text-blue-600 border border-gray-300 rounded-lg hover:bg-gray-50"
                  title="Copy link"
                >
                  {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-1">
                Code: <span className="font-mono">{state.code}</span>
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Join mode</label>
              <select
                value={state.mode}
                disabled={saving}
                onChange={(e) => update({ mode: e.target.value as "instant" | "approval" })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
              >
                <option value="instant">Instant access — new signups can log in right away</option>
                <option value="approval">Require approval — new signups wait for an admin</option>
              </select>
            </div>

            {state.mode === "approval" && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Auto-approve email domains
                </label>
                <p className="text-xs text-gray-500 mb-2">
                  Signups from these domains skip approval and get in instantly. Everyone else
                  still waits for an admin. Example: <span className="font-mono">carexperts.com</span>
                </p>
                {state.autoApproveDomains.length > 0 && (
                  <div className="flex flex-wrap gap-2 mb-2">
                    {state.autoApproveDomains.map((domain) => (
                      <span
                        key={domain}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-full text-xs font-medium"
                      >
                        @{domain}
                        <button
                          onClick={() => removeDomain(domain)}
                          disabled={saving}
                          className="text-indigo-400 hover:text-indigo-700 disabled:opacity-50"
                          title={`Remove ${domain}`}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={domainInput}
                    onChange={(e) => setDomainInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addDomains();
                      }
                    }}
                    placeholder="carexperts.com"
                    className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
                  />
                  <button
                    onClick={addDomains}
                    disabled={saving || !domainInput.trim()}
                    className="px-3 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                  >
                    Add
                  </button>
                </div>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Default role for new members</label>
              <select
                value={state.defaultRole}
                disabled={saving}
                onChange={(e) => update({ defaultRole: e.target.value as "user" | "viewer" })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
              >
                <option value="user">User — can view and update vehicle recommendations</option>
                <option value="viewer">Viewer — read-only access</option>
              </select>
            </div>

            <button
              onClick={rotate}
              disabled={rotating}
              className="inline-flex items-center gap-2 px-3 py-2 text-sm border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {rotating ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Rotate code
            </button>
            {state.rotatedAt && (
              <p className="text-xs text-gray-400">
                Last rotated {new Date(state.rotatedAt).toLocaleString()}
              </p>
            )}
          </div>

          <div className="flex flex-col items-center justify-center gap-3">
            {qrDataUrl ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={qrDataUrl}
                  alt="Enrollment QR code"
                  className="w-48 h-48 border border-gray-200 rounded-lg"
                />
                <a
                  href={qrDataUrl}
                  download="enrollment-qr.png"
                  className="inline-flex items-center gap-2 px-3 py-2 text-sm border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50"
                >
                  <Download className="w-4 h-4" />
                  Download QR
                </a>
                <p className="text-xs text-gray-500 text-center max-w-[220px]">
                  Print this and post it in the shop — staff scan it to create their account.
                </p>
              </>
            ) : (
              <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
            )}
          </div>
        </div>
      )}

      {state.enabled && !state.code && (
        <div className="p-6 text-sm text-gray-500">Generating code…</div>
      )}
    </div>
  );
}
