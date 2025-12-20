"use client";

import { useState, useEffect } from "react";
import {
  Settings,
  CheckCircle2,
  XCircle,
  Loader2,
  Link2,
  Key,
  AlertCircle,
} from "lucide-react";

export default function ProtractorSettingsPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<{
    configured: boolean;
    connectionId?: string;
    hasApiKey?: boolean;
  } | null>(null);
  const [connectionId, setConnectionId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; locations?: any[]; error?: string } | null>(null);

  useEffect(() => {
    fetchStatus();
  }, []);

  async function fetchStatus() {
    try {
      const res = await fetch("/api/settings/protractor", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
      }
    } catch (err) {
      console.error("Failed to fetch Protractor status:", err);
    } finally {
      setLoading(false);
    }
  }

  async function handleTest() {
    if (!connectionId || !apiKey) {
      setMessage({ type: "error", text: "Please enter both Connection ID and API Key" });
      return;
    }

    setTesting(true);
    setMessage(null);
    setTestResult(null);

    try {
      const res = await fetch("/api/settings/protractor/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ connectionId, apiKey }),
      });

      const data = await res.json();
      setTestResult(data);

      if (data.ok) {
        setMessage({ type: "success", text: "Connection test successful!" });
      } else {
        setMessage({ type: "error", text: data.error || "Connection test failed" });
      }
    } catch (err: any) {
      setMessage({ type: "error", text: err.message || "Test failed" });
    } finally {
      setTesting(false);
    }
  }

  async function handleSave() {
    if (!connectionId || !apiKey) {
      setMessage({ type: "error", text: "Please enter both Connection ID and API Key" });
      return;
    }

    setSaving(true);
    setMessage(null);

    try {
      const res = await fetch("/api/settings/protractor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ connectionId, apiKey }),
      });

      const data = await res.json();

      if (res.ok && data.ok) {
        setMessage({ type: "success", text: "Protractor connected successfully!" });
        setConnectionId("");
        setApiKey("");
        fetchStatus();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to save settings" });
      }
    } catch (err: any) {
      setMessage({ type: "error", text: err.message || "Save failed" });
    } finally {
      setSaving(false);
    }
  }

  async function handleDisconnect() {
    if (!confirm("Are you sure you want to disconnect Protractor?")) return;

    setSaving(true);
    setMessage(null);

    try {
      const res = await fetch("/api/settings/protractor", {
        method: "DELETE",
        credentials: "include",
      });

      const data = await res.json();

      if (res.ok && data.ok) {
        setMessage({ type: "success", text: "Protractor disconnected" });
        fetchStatus();
      } else {
        setMessage({ type: "error", text: data.error || "Failed to disconnect" });
      }
    } catch (err: any) {
      setMessage({ type: "error", text: err.message || "Disconnect failed" });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto p-6">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <Settings className="w-6 h-6" />
          Protractor Integration
        </h1>
        <p className="mt-2 text-gray-600">
          Connect to Protractor to sync vehicles, work orders, and service history.
        </p>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
        <div className="p-6 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Connection Status</h2>
          <div className="mt-4 flex items-center gap-3">
            {status?.configured ? (
              <>
                <CheckCircle2 className="w-5 h-5 text-green-600" />
                <span className="text-green-700 font-medium">Connected</span>
                <span className="text-gray-500 text-sm">
                  (ID: {status.connectionId})
                </span>
              </>
            ) : (
              <>
                <XCircle className="w-5 h-5 text-gray-400" />
                <span className="text-gray-600">Not connected</span>
              </>
            )}
          </div>
        </div>

        {status?.configured ? (
          <div className="p-6">
            <p className="text-gray-600 mb-4">
              Your shop is connected to Protractor. Vehicle data, work orders, and
              service history will sync automatically.
            </p>
            <button
              onClick={handleDisconnect}
              disabled={saving}
              className="px-4 py-2 bg-red-50 text-red-700 rounded-lg border border-red-200 hover:bg-red-100 transition-colors disabled:opacity-50"
            >
              {saving ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Disconnecting...
                </span>
              ) : (
                "Disconnect Protractor"
              )}
            </button>
          </div>
        ) : (
          <div className="p-6 space-y-6">
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-blue-600 mt-0.5" />
                <div>
                  <h3 className="font-medium text-blue-900">How to get your credentials</h3>
                  <p className="text-sm text-blue-800 mt-1">
                    Contact your Protractor administrator or support to obtain your
                    Connection ID and API Key. These are unique to your shop location.
                  </p>
                </div>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                <span className="flex items-center gap-2">
                  <Link2 className="w-4 h-4" />
                  Connection ID
                </span>
              </label>
              <input
                type="text"
                value={connectionId}
                onChange={(e) => setConnectionId(e.target.value)}
                placeholder="e.g., 5fecbc20-0f0e-4a7c-bf41-040e11047e56"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                <span className="flex items-center gap-2">
                  <Key className="w-4 h-4" />
                  API Key
                </span>
              </label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="e.g., 2de51c4f-d0f0-4b9f-abeb-95225e87da70"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            {message && (
              <div
                className={`p-4 rounded-lg ${
                  message.type === "success"
                    ? "bg-green-50 text-green-800 border border-green-200"
                    : "bg-red-50 text-red-800 border border-red-200"
                }`}
              >
                {message.text}
              </div>
            )}

            {testResult?.ok && testResult.locations && testResult.locations.length > 0 && (
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                <h4 className="font-medium text-green-900 mb-2">Locations Found:</h4>
                <ul className="text-sm text-green-800 space-y-1">
                  {testResult.locations.map((loc: any, i: number) => (
                    <li key={i}>
                      {loc.Name || loc.ID || `Location ${i + 1}`}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={handleTest}
                disabled={testing || saving || !connectionId || !apiKey}
                className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg border border-gray-300 hover:bg-gray-200 transition-colors disabled:opacity-50"
              >
                {testing ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Testing...
                  </span>
                ) : (
                  "Test Connection"
                )}
              </button>

              <button
                onClick={handleSave}
                disabled={saving || testing || !connectionId || !apiKey}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
              >
                {saving ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Connecting...
                  </span>
                ) : (
                  "Connect Protractor"
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
