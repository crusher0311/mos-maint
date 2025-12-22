"use client";

import { useState, useEffect } from "react";
import { Settings, CheckCircle, XCircle, Loader2, Info, RefreshCw, Key, Hash, ChevronDown, ChevronUp } from "lucide-react";

interface AutoVitalsSettings {
  welcomeCode: string;
  personalCode: string;
  sessionCookie: string;
  shopId: number | null;
  shopName: string;
  isConfigured: boolean;
  lastSync: string | null;
}

export default function AutoVitalsSettingsPage() {
  const [settings, setSettings] = useState<AutoVitalsSettings>({
    welcomeCode: "",
    personalCode: "",
    sessionCookie: "",
    shopId: null,
    shopName: "",
    isConfigured: false,
    lastSync: null,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchSettings();
  }, []);

  async function fetchSettings() {
    try {
      const res = await fetch("/api/autovitals/settings");
      if (res.ok) {
        const data = await res.json();
        setSettings({
          welcomeCode: "",
          personalCode: "",
          sessionCookie: "",
          shopId: data.shopId || null,
          shopName: data.shopName || "",
          isConfigured: data.isConfigured || false,
          lastSync: data.lastSync || null,
        });
      }
    } catch (err) {
      console.error("Failed to fetch AutoVitals settings:", err);
    } finally {
      setLoading(false);
    }
  }

  async function handleConnect() {
    setSaving(true);
    setError(null);
    setTestResult(null);

    try {
      const res = await fetch("/api/autovitals/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          welcomeCode: settings.welcomeCode,
          personalCode: settings.personalCode,
          sessionCookie: settings.sessionCookie,
          shopId: settings.shopId,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to connect");
      }

      await fetchSettings();
      setTestResult({ 
        success: true, 
        message: data.shopName 
          ? `Connected to ${data.shopName}!` 
          : "Connected successfully!" 
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect");
    } finally {
      setSaving(false);
    }
  }

  async function handleSync() {
    setSyncing(true);
    setError(null);

    try {
      const res = await fetch("/api/autovitals/sync", {
        method: "POST",
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Sync failed");
      }

      await fetchSettings();
      setTestResult({ 
        success: true, 
        message: `Synced ${data.appointments || 0} appointments and ${data.inspections || 0} inspections` 
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  async function handleDisconnect() {
    if (!confirm("Are you sure you want to disconnect AutoVitals?")) return;

    setSaving(true);
    setError(null);

    try {
      const res = await fetch("/api/autovitals/settings", {
        method: "DELETE",
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to disconnect");
      }

      await fetchSettings();
      setTestResult({ success: true, message: "Disconnected from AutoVitals" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disconnect");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 bg-green-100 rounded-lg">
          <Settings className="w-6 h-6 text-green-600" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">AutoVitals Integration</h1>
          <p className="text-gray-500">Connect to AutoVitals to import inspection data</p>
        </div>
      </div>

      {settings.isConfigured ? (
        <div className="space-y-6">
          <div className="bg-green-50 border border-green-200 rounded-lg p-4">
            <div className="flex items-center gap-3">
              <CheckCircle className="w-6 h-6 text-green-600" />
              <div>
                <p className="font-medium text-green-900">Connected to AutoVitals</p>
                <p className="text-sm text-green-700">
                  {settings.shopName || `Shop ID: ${settings.shopId}`}
                </p>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Sync Inspection Data</h2>
            <p className="text-gray-600 mb-4">
              Import the latest appointments and inspection results from AutoVitals. 
              This data will appear on vehicle Plan pages.
            </p>
            
            {settings.lastSync && (
              <p className="text-sm text-gray-500 mb-4">
                Last synced: {new Date(settings.lastSync).toLocaleString()}
              </p>
            )}

            <div className="flex gap-3">
              <button
                onClick={handleSync}
                disabled={syncing}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {syncing ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Syncing...
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-4 h-4" />
                    Sync Now
                  </>
                )}
              </button>

              <button
                onClick={handleDisconnect}
                disabled={saving}
                className="px-4 py-2 bg-red-100 text-red-700 rounded-lg hover:bg-red-200 disabled:opacity-50"
              >
                Disconnect
              </button>
            </div>
          </div>

          {testResult && (
            <div className={`flex items-center gap-2 p-3 rounded-lg ${
              testResult.success ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
            }`}>
              {testResult.success ? (
                <CheckCircle className="w-5 h-5" />
              ) : (
                <XCircle className="w-5 h-5" />
              )}
              <span>{testResult.message}</span>
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 text-red-700">
              <XCircle className="w-5 h-5" />
              <span>{error}</span>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <div className="flex gap-3">
              <Info className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-blue-800">
                <p className="font-medium mb-1">Connect with your AutoVitals login codes</p>
                <p className="text-blue-700">
                  Enter the same <strong>Welcome Code</strong> and <strong>Personal Code</strong> you use 
                  to log into AutoVitals. If you don't know them, check with your shop manager or 
                  click "Do Not Know Your Login Codes" on the AutoVitals login page.
                </p>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                <Hash className="w-4 h-4 inline mr-1" />
                Welcome Code
              </label>
              <input
                type="text"
                value={settings.welcomeCode}
                onChange={(e) => setSettings({ ...settings, welcomeCode: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
                placeholder="Your shop's welcome code"
              />
              <p className="text-xs text-gray-500 mt-1">This is your shop's code, shared by all employees</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                <Key className="w-4 h-4 inline mr-1" />
                Personal Code
              </label>
              <input
                type="text"
                value={settings.personalCode}
                onChange={(e) => setSettings({ ...settings, personalCode: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
                placeholder="Your personal login code"
              />
              <p className="text-xs text-gray-500 mt-1">This is your individual employee code</p>
            </div>

            <div>
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex items-center gap-1 text-sm text-gray-600 hover:text-gray-900"
              >
                {showAdvanced ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                Advanced options (for technical users)
              </button>
              
              {showAdvanced && (
                <div className="mt-4 p-4 bg-gray-50 rounded-lg space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Shop ID (optional)
                    </label>
                    <input
                      type="number"
                      value={settings.shopId || ""}
                      onChange={(e) => setSettings({ ...settings, shopId: parseInt(e.target.value) || null })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500"
                      placeholder="e.g., 11876"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Session Cookie (if auto-login doesn't work)
                    </label>
                    <textarea
                      value={settings.sessionCookie}
                      onChange={(e) => setSettings({ ...settings, sessionCookie: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500 font-mono text-xs"
                      rows={2}
                      placeholder="Paste from browser dev tools if needed..."
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Only needed if automatic connection fails. Copy from Network tab in browser developer tools.
                    </p>
                  </div>
                </div>
              )}
            </div>

            {testResult && (
              <div className={`flex items-center gap-2 p-3 rounded-lg ${
                testResult.success ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
              }`}>
                {testResult.success ? (
                  <CheckCircle className="w-5 h-5" />
                ) : (
                  <XCircle className="w-5 h-5" />
                )}
                <span>{testResult.message}</span>
              </div>
            )}

            {error && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 text-red-700">
                <XCircle className="w-5 h-5" />
                <span>{error}</span>
              </div>
            )}

            <div className="pt-4 border-t border-gray-200">
              <button
                onClick={handleConnect}
                disabled={saving || (!settings.welcomeCode || !settings.personalCode) && !settings.sessionCookie}
                className="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {saving ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Connecting...
                  </>
                ) : (
                  "Connect to AutoVitals"
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
